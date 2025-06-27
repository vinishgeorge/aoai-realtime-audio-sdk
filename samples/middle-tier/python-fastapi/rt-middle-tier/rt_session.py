import asyncio
import json
import os
import uuid
from typing import Literal, TypedDict, Union

from azure.core.credentials import AzureKeyCredential
from azure.identity.aio import DefaultAzureCredential
from fastapi import WebSocket
from loguru import logger
from rtclient import (
    InputAudioTranscription,
    RTClient,
    ServerVAD,
    RTInputAudioItem,
    RTResponse,
    RTAudioContent,
)


class TextDelta(TypedDict):
    id: str
    type: Literal["text_delta"]
    delta: str


class Transcription(TypedDict):
    id: str
    type: Literal["transcription"]
    text: str


class UserMessage(TypedDict):
    id: str
    type: Literal["user_message"]
    text: str


class ControlMessage(TypedDict):
    type: Literal["control"]
    action: str
    greeting: str | None = None
    id: str | None = None


WSMessage = Union[TextDelta, Transcription, UserMessage, ControlMessage]


class RTSession:
    """Manage a realtime WebSocket session."""

    def __init__(self, websocket: WebSocket, backend: str | None) -> None:
        self.session_id = str(uuid.uuid4())
        self.websocket = websocket
        self.logger = logger.bind(session_id=self.session_id)
        self.credential: DefaultAzureCredential | None = None
        self.client = self._initialize_client(backend)
        self.logger.info("New session created")

    async def __aenter__(self):
        if self.credential is not None:
            await self.credential.__aenter__()
        await self.client.__aenter__()
        return self

    async def __aexit__(self, exc_type, exc_value, traceback):
        await self.client.__aexit__(exc_type, exc_value, traceback)
        if self.credential is not None:
            await self.credential.__aexit__(exc_type, exc_value, traceback)
        self.logger.info("Session closed")

    def _initialize_client(self, backend: str | None) -> RTClient:
        self.logger.debug("Initializing RT client with backend: %s", backend)
        if backend == "azure" or backend is None:
            self.logger.info(
                "Using Azure OpenAI backend at %s with deployment %s",
                os.getenv("AZURE_OPENAI_ENDPOINT"),
                os.getenv("AZURE_OPENAI_DEPLOYMENT"),
            )
            self.credential = DefaultAzureCredential()
            return RTClient(
                url=os.getenv("AZURE_OPENAI_ENDPOINT"),
                token_credential=self.credential,
                azure_deployment=os.getenv("AZURE_OPENAI_DEPLOYMENT"),
            )
        return RTClient(
            key_credential=AzureKeyCredential(os.getenv("OPENAI_API_KEY")),
            model=os.getenv("OPENAI_MODEL"),
        )

    async def send(self, message: WSMessage) -> None:
        await self.websocket.send_json(message)

    async def send_binary(self, message: bytes) -> None:
        await self.websocket.send_bytes(message)

    async def initialize(self) -> None:
        self.logger.debug("Configuring realtime session")
        await self.client.configure(
            modalities={"text", "audio"},
            voice="coral",
            input_audio_format="pcm16",
            input_audio_transcription=InputAudioTranscription(model="whisper-1"),
            turn_detection=ServerVAD(),
        )
        greeting: ControlMessage = {
            "type": "control",
            "action": "connected",
            "greeting": "You are now connected to the FastAPI server",
        }
        await self.send(greeting)
        self.logger.debug("Realtime session configured successfully")
        asyncio.create_task(self.start_event_loop())

    async def handle_binary_message(self, message: bytes) -> None:
        try:
            await self.client.send_audio(message)
        except Exception as error:
            self.logger.error("Failed to send audio data: %s", error)
            raise

    async def handle_text_message(self, message: str) -> None:
        try:
            parsed: WSMessage = json.loads(message)
            self.logger.debug("Received text message type: %s", parsed["type"])
            if parsed["type"] == "user_message":
                await self.client.send_item(
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": parsed["text"]}],
                    }
                )
                await self.client.generate_response()
                self.logger.debug("User message processed successfully")
        except Exception as error:
            self.logger.error("Failed to process user message: %s", error)
            raise

    async def handle_text_content(self, content) -> None:
        try:
            content_id = f"{content.item_id}-{content.content_index}"
            async for text in content.text_chunks():
                delta_message: TextDelta = {
                    "id": content_id,
                    "type": "text_delta",
                    "delta": text,
                }
                await self.send(delta_message)
            await self.send(
                {"type": "control", "action": "text_done", "id": content_id}
            )
            self.logger.debug("Text content processed successfully")
        except Exception as error:
            self.logger.error("Error handling text content: %s", error)
            raise

    async def handle_audio_content(self, content: RTAudioContent) -> None:
        async def handle_audio_chunks():
            async for chunk in content.audio_chunks():
                await self.send_binary(chunk)

        async def handle_audio_transcript():
            content_id = f"{content.item_id}-{content.content_index}"
            async for chunk in content.transcript_chunks():
                await self.send(
                    {"id": content_id, "type": "text_delta", "delta": chunk}
                )
            await self.send(
                {"type": "control", "action": "text_done", "id": content_id}
            )

        try:
            await asyncio.gather(handle_audio_chunks(), handle_audio_transcript())
            self.logger.debug("Audio content processed successfully")
        except Exception as error:
            self.logger.error("Error handling audio content: %s", error)
            raise

    async def handle_response(self, event: RTResponse) -> None:
        try:
            async for item in event:
                if item.type == "message":
                    async for content in item:
                        if content.type == "text":
                            await self.handle_text_content(content)
                        elif content.type == "audio":
                            await self.handle_audio_content(content)
            self.logger.debug("Response handled successfully")
        except Exception as error:
            self.logger.error("Error handling response: %s", error)
            raise

    async def handle_input_audio(self, event: RTInputAudioItem) -> None:
        try:
            await self.send({"type": "control", "action": "speech_started"})
            await event
            transcription: Transcription = {
                "id": event.id,
                "type": "transcription",
                "text": event.transcript or "",
            }
            await self.send(transcription)
            self.logger.debug(
                "Input audio processed successfully, transcription length: %s",
                len(transcription["text"]),
            )
        except Exception as error:
            self.logger.error("Error handling input audio: %s", error)
            raise

    async def start_event_loop(self) -> None:
        try:
            self.logger.debug("Starting event loop")
            async for event in self.client.events():
                if event.type == "response":
                    await self.handle_response(event)
                elif event.type == "input_audio":
                    await self.handle_input_audio(event)
        except Exception as error:
            self.logger.error("Error in event loop: %s", error)
            raise

from fastapi import FastAPI, WebSocket, UploadFile, File
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.websockets import WebSocketState
import uvicorn
import uuid
import json
from typing import Union, Literal, TypedDict, Dict, List, Tuple
import asyncio
from loguru import logger
import os
from dotenv import load_dotenv
from azure.identity.aio import DefaultAzureCredential
from langchain_community.llms.ollama import Ollama
from azure.core.credentials import AzureKeyCredential
from rtclient import (
    InputAudioTranscription,
    RTClient,
    ServerVAD,
    RTInputAudioItem,
    RTResponse,
    RTAudioContent,
)
from sentence_transformers import SentenceTransformer, util
import io
from pypdf import PdfReader
import docx2txt
import pandas as pd
from bs4 import BeautifulSoup
import markdown
import tempfile
import subprocess
import weaviate
from weaviate.connect import ConnectionParams, ProtocolParams
from weaviate.classes.data import DataObject
from urllib.parse import urlparse

load_dotenv()

document_chunks = []
document_embeddings = []
embedder = SentenceTransformer("all-MiniLM-L6-v2")

# Simple in-memory storage for conversation history.
# Maps a session id to a list of (question, answer) tuples.
mem0: Dict[str, List[Tuple[str, str]]] = {}

WEAVIATE_URL = os.getenv("WEAVIATE_URL", "http://localhost:8080")
WEAVIATE_GRPC_PORT = int(os.getenv("WEAVIATE_GRPC_PORT", "50051"))
weaviate_client = None


def get_weaviate_client():
    global weaviate_client
    if weaviate_client is None:
        url = urlparse(WEAVIATE_URL)
        params = ConnectionParams(
            http=ProtocolParams(
                host=url.hostname or "localhost",
                port=url.port or 80,
                secure=url.scheme == "https",
            ),
            grpc=ProtocolParams(
                host=url.hostname or "localhost",
                port=WEAVIATE_GRPC_PORT,
                secure=url.scheme == "https",
            ),
        )
        weaviate_client = weaviate.WeaviateClient(
            connection_params=params, skip_init_checks=True
        )
        try:
            weaviate_client.connect()
        except Exception as e:
            logger.warning(f"Could not connect to Weaviate: {e}")
    return weaviate_client


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


class Phi3Request(BaseModel):
    prompt: str
    session_id: str | None = None


WSMessage = Union[TextDelta, Transcription, UserMessage, ControlMessage]


class RTSession:
    def __init__(self, websocket: WebSocket, backend: str | None):
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

    def _initialize_client(self, backend: str | None):
        self.logger.debug(f"Initializing RT client with backend: {backend}")

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

    async def send(self, message: WSMessage):
        await self.websocket.send_json(message)

    async def send_binary(self, message: bytes):
        await self.websocket.send_bytes(message)

    async def initialize(self):
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

    async def handle_binary_message(self, message: bytes):
        try:
            await self.client.send_audio(message)
        except Exception as error:
            self.logger.error(f"Failed to send audio data: {error}")
            raise

    async def handle_text_message(self, message: str):
        try:
            parsed: WSMessage = json.loads(message)
            self.logger.debug(f"Received text message type: {parsed['type']}")

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
            self.logger.error(f"Failed to process user message: {error}")
            raise

    async def handle_text_content(self, content):
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
            self.logger.error(f"Error handling text content: {error}")
            raise

    async def handle_audio_content(self, content: RTAudioContent):
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
            self.logger.error(f"Error handling audio content: {error}")
            raise

    async def handle_response(self, event: RTResponse):
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
            self.logger.error(f"Error handling response: {error}")
            raise

    async def handle_input_audio(self, event: RTInputAudioItem):
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
                f"Input audio processed successfully, transcription length: {len(transcription['text'])}"
            )
        except Exception as error:
            self.logger.error(f"Error handling input audio: {error}")
            raise

    async def start_event_loop(self):
        try:
            self.logger.debug("Starting event loop")
            async for event in self.client.events():
                if event.type == "response":
                    await self.handle_response(event)
                elif event.type == "input_audio":
                    await self.handle_input_audio(event)
        except Exception as error:
            self.logger.error(f"Error in event loop: {error}")
            raise


app = FastAPI()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/phi3")
async def phi3_endpoint(req: Phi3Request):
    global document_chunks, document_embeddings, mem0

    base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    model = os.getenv("PHI3_MODEL", "phi3.5:3.8b")
    llm = Ollama(base_url=base_url, model=model)

    session_id = req.session_id or "default"
    history = mem0.get(session_id, [])

    final_prompt = req.prompt
    context = ""

    client = get_weaviate_client()
    if client is not None and client.collections.exists("DocumentChunk"):
        collection = client.collections.get("DocumentChunk")
        query_embedding = embedder.encode(req.prompt)
        try:
            results = collection.query.near_vector(query_embedding.tolist(), limit=3)
            context = "\n---\n".join(obj.properties["text"] for obj in results.objects)
        except Exception as e:
            logger.warning(f"Weaviate query failed: {e}")
    elif len(document_chunks) > 0 and len(document_embeddings) > 0:
        query_embedding = embedder.encode(req.prompt, convert_to_tensor=True)
        top_results = util.semantic_search(
            query_embedding, document_embeddings, top_k=3
        )
        context = "\n---\n".join(
            document_chunks[match["corpus_id"]] for match in top_results[0]
        )

    conversation = ""
    if history:
        conversation = "\n".join(f"User: {q}\nAssistant: {a}" for q, a in history)

    if context:
        final_prompt = (
            "Use the following document excerpts to answer the question.\n\n"
            f"{context}\n\n"
        )
        if conversation:
            final_prompt += f"{conversation}\nUser: {req.prompt}\nAssistant:"
        else:
            final_prompt += f"Question: {req.prompt}\nAnswer:"
    else:
        if conversation:
            final_prompt = f"{conversation}\nUser: {req.prompt}\nAssistant:"
        else:
            final_prompt = req.prompt

    response = await llm.apredict(final_prompt)

    # Store the exchange for future context, keeping only the latest 10 turns
    history.append((req.prompt, response))
    mem0[session_id] = history[-10:]

    return {"response": response}


@app.websocket("/realtime")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info("New WebSocket connection established")

    async with RTSession(websocket, os.getenv("BACKEND")) as session:
        try:
            await session.initialize()

            while websocket.client_state != WebSocketState.DISCONNECTED:
                message = await websocket.receive()
                if "bytes" in message:
                    await session.handle_binary_message(message["bytes"])
                elif "text" in message:
                    await session.handle_text_message(message["text"])
        except Exception as e:
            logger.error(f"WebSocket error: {e}")
        finally:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close()
            logger.info("WebSocket connection closed")


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    global document_chunks, document_embeddings

    contents = await file.read()
    ext = os.path.splitext(file.filename)[1].lower()

    if ext == ".pdf":
        reader = PdfReader(io.BytesIO(contents))
        text = "\n".join(
            page.extract_text() for page in reader.pages if page.extract_text()
        )
    elif ext in {".txt"}:
        text = contents.decode("utf-8", errors="ignore")
    elif ext in {".md"}:
        md_text = contents.decode("utf-8", errors="ignore")
        html = markdown.markdown(md_text)
        text = BeautifulSoup(html, "html.parser").get_text()
    elif ext in {".docx"}:
        text = docx2txt.process(io.BytesIO(contents))
    elif ext in {".doc"}:
        with tempfile.NamedTemporaryFile(suffix=".doc") as tmp:
            tmp.write(contents)
            tmp.flush()
            result = subprocess.run(
                ["antiword", tmp.name], capture_output=True, text=True
            )
            text = result.stdout
    elif ext in {".xls", ".xlsx"}:
        df = pd.read_excel(io.BytesIO(contents), header=None, dtype=str)
        text = "\n".join(
            " ".join(filter(None, map(str, row.dropna()))) for _, row in df.iterrows()
        )
    else:
        return {"error": "Unsupported file format."}

    # Chunk and embed
    document_chunks = [text[i : i + 500] for i in range(0, len(text), 500)]
    embeddings = embedder.encode(document_chunks)
    document_embeddings = embeddings

    client = get_weaviate_client()
    if client is not None:
        try:
            if not client.collections.exists("DocumentChunk"):
                client.collections.create(
                    "DocumentChunk",
                    vectorizer="none",
                    properties=[{"name": "text", "dataType": "text"}],
                )
            collection = client.collections.get("DocumentChunk")
            objects = [
                DataObject(properties={"text": chunk}, vector=vector.tolist())
                for chunk, vector in zip(document_chunks, embeddings)
            ]
            collection.data.insert_many(objects)
        except Exception as e:
            logger.warning(f"Failed to store in Weaviate: {e}")

    return {"status": "Document uploaded and processed", "chunks": len(document_chunks)}


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")

from fastapi import FastAPI, WebSocket, UploadFile, File
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.websockets import WebSocketState
from pydantic import BaseModel
from loguru import logger
import uvicorn
import os
from typing import Dict, List, Tuple
from dotenv import load_dotenv
import re

from .document_store import DocumentStore
from .llm import ModelFactory
from .rt_session import RTSession


load_dotenv()

# Simple in-memory storage for conversation history
mem0: Dict[str, List[Tuple[str, str]]] = {}

document_store = DocumentStore()


class Phi3Request(BaseModel):
    prompt: str
    session_id: str | None = None


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/phi3")
async def phi3_endpoint(req: Phi3Request):
    global mem0
    llm = ModelFactory.create()

    session_id = req.session_id or "default"
    history = mem0.get(session_id, [])

    context = document_store.search(req.prompt)
    conversation = (
        "\n".join(f"User: {q}\nAssistant: {a}" for q, a in history) if history else ""
    )

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
        final_prompt = (
            f"{conversation}\nUser: {req.prompt}\nAssistant:"
            if conversation
            else req.prompt
        )

    logger.info(f"Final prompt for LLM: {final_prompt}")
    response = await llm.generate(final_prompt)

    history.append((req.prompt, response))
    mem0[session_id] = history[-10:]

    return {"response": response}


@app.post("/phi3-stream")
async def phi3_stream(req: Phi3Request):
    """Stream phi3 response tokens using Server Sent Events."""
    global mem0
    llm = ModelFactory.create()

    session_id = req.session_id or "default"
    history = mem0.get(session_id, [])

    context = document_store.search(req.prompt)
    conversation = (
        "\n".join(f"User: {q}\nAssistant: {a}" for q, a in history) if history else ""
    )

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
        final_prompt = (
            f"{conversation}\nUser: {req.prompt}\nAssistant:"
            if conversation
            else req.prompt
        )

    logger.info(f"Streaming prompt for LLM: {final_prompt}")

    async def token_generator():
        collected = ""
        buffer = ""
        pattern = re.compile(r"^\s*\S+[.,!?;:](?=\s|$)|^\s*\S+\s+")
        async for token in llm.stream(final_prompt):
            buffer += token
            while True:
                match = pattern.match(buffer)
                if not match:
                    break
                piece = match.group(0)
                buffer = buffer[len(piece) :]
                collected += piece
                yield f"data: {piece}\n\n"
        if buffer:
            collected += buffer
            yield f"data: {buffer}\n\n"
        history.append((req.prompt, collected))
        mem0[session_id] = history[-10:]

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(
        token_generator(), media_type="text/event-stream", headers=headers
    )


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
        except Exception as exc:
            logger.error(f"WebSocket error: {exc}")
        finally:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close()
            logger.info("WebSocket connection closed")


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    logger.info(f"Received file upload: {file.filename}")

    contents = await file.read()
    document_store.update_from_bytes(contents, file.filename)
    return {
        "status": "Document uploaded and processed",
        "chunks": len(document_store.chunks),
    }


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")

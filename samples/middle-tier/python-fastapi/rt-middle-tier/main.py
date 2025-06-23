from fastapi import FastAPI, WebSocket, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.websockets import WebSocketState
from pydantic import BaseModel
from loguru import logger
import uvicorn
import os
import io
import tempfile
import subprocess
import json
import uuid
from typing import Dict, List, Tuple, Union, Literal, TypedDict
import pandas as pd
from bs4 import BeautifulSoup
import markdown
from pypdf import PdfReader
import docx2txt
from dotenv import load_dotenv

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
    conversation = "\n".join(f"User: {q}\nAssistant: {a}" for q, a in history) if history else ""

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
    ext = os.path.splitext(file.filename)[1].lower()

    if ext == ".pdf":
        reader = PdfReader(io.BytesIO(contents))
        text = "\n".join(page.extract_text() for page in reader.pages if page.extract_text())
    elif ext == ".txt":
        text = contents.decode("utf-8", errors="ignore")
    elif ext == ".md":
        md_text = contents.decode("utf-8", errors="ignore")
        html = markdown.markdown(md_text)
        text = BeautifulSoup(html, "html.parser").get_text()
    elif ext == ".docx":
        text = docx2txt.process(io.BytesIO(contents))
    elif ext == ".doc":
        with tempfile.NamedTemporaryFile(suffix=".doc") as tmp:
            tmp.write(contents)
            tmp.flush()
            result = subprocess.run(["antiword", tmp.name], capture_output=True, text=True)
            text = result.stdout
    elif ext in {".xls", ".xlsx"}:
        df = pd.read_excel(io.BytesIO(contents), header=None, dtype=str)
        text = "\n".join(" ".join(filter(None, map(str, row.dropna()))) for _, row in df.iterrows())
    else:
        return {"error": "Unsupported file format."}

    logger.info(f"File {file.filename} processed, extracted text length: {len(text)}")
    document_store.update(text)
    return {"status": "Document uploaded and processed", "chunks": len(document_store.chunks)}


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")

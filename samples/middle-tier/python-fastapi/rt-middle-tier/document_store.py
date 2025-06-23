import os
from typing import List
from loguru import logger
from sentence_transformers import SentenceTransformer, util
import weaviate
from weaviate.classes.data import DataObject
from weaviate.classes.config import Configure, Property, DataType
from weaviate.classes.init import Auth


embedder = SentenceTransformer("all-MiniLM-L6-v2")

WEAVIATE_HOST = os.getenv("WEAVIATE_HOST")
WEAVIATE_PORT = int(os.getenv("WEAVIATE_PORT", "0"))
WEAVIATE_SECURE = bool(os.getenv("WEAVIATE_SECURE"))
WEAVIATE_GRPC_HOST = os.getenv("WEAVIATE_GRPC_HOST")
WEAVIATE_GRPC_PORT = int(os.getenv("WEAVIATE_GRPC_PORT", "50051"))
WEAVIATE_GRPC_SECURE = bool(os.getenv("WEAVIATE_GRPC_SECURE"))
WEAVIATE_AUTH_CREDENTIALS = os.getenv("WEAVIATE_AUTH_CREDENTIALS")

weaviate_client = None


def get_weaviate_client():
    """Initialize and return a Weaviate client instance."""
    global weaviate_client
    if weaviate_client is None:
        try:
            logger.info(
                "Connecting to Weaviate at %s:%s secure=%s",
                WEAVIATE_HOST,
                WEAVIATE_PORT,
                WEAVIATE_SECURE,
            )
            weaviate_client = weaviate.connect_to_custom(
                http_host=WEAVIATE_HOST,
                http_port=WEAVIATE_PORT,
                http_secure=WEAVIATE_SECURE,
                grpc_host=WEAVIATE_GRPC_HOST,
                grpc_port=WEAVIATE_GRPC_PORT,
                grpc_secure=WEAVIATE_GRPC_SECURE,
                auth_credentials=Auth.api_key(WEAVIATE_AUTH_CREDENTIALS),
            )
        except Exception as exc:
            logger.warning(f"Could not connect to Weaviate: {exc}")
    return weaviate_client


class DocumentStore:
    """Manage document chunks and semantic search."""

    def __init__(self) -> None:
        self.chunks: List[str] = []
        self.embeddings = []
        self.client = get_weaviate_client()

    def update(self, text: str) -> None:
        """Split, embed, and store chunks from a document."""
        self.chunks = [text[i : i + 500] for i in range(0, len(text), 500)]
        self.embeddings = embedder.encode(self.chunks)

        if self.client is None:
            logger.warning("Weaviate client not initialized, skipping storage")
            return

        try:
            try:
                self.client.collections.delete("DocumentChunk")
            except Exception:
                logger.debug("No existing DocumentChunk collection to delete")

            self.client.collections.create(
                name="DocumentChunk",
                description="Document chunks for semantic search",
                properties=[Property(name="text", data_type=DataType.TEXT)],
                vectorizer_config=Configure.Vectorizer.none(),
            )
            collection = self.client.collections.get("DocumentChunk")
            objects = [
                DataObject(properties={"text": chunk}, vector=vector.tolist())
                for chunk, vector in zip(self.chunks, self.embeddings)
            ]
            collection.data.insert_many(objects)
            logger.info("Stored document chunks in Weaviate")
        except Exception as exc:
            logger.warning(f"Failed to store in Weaviate: {exc}")

    def search(self, query: str) -> str:
        """Retrieve relevant context for the query."""
        if self.client is not None and self.client.collections.exists("DocumentChunk"):
            collection = self.client.collections.get("DocumentChunk")
            query_embedding = embedder.encode(query)
            try:
                results = collection.query.near_vector(query_embedding.tolist(), limit=3)
                return "\n---\n".join(obj.properties["text"] for obj in results.objects)
            except Exception as exc:
                logger.warning(f"Weaviate query failed: {exc}")

        if self.chunks and self.embeddings:
            query_embedding = embedder.encode(query, convert_to_tensor=True)
            top_results = util.semantic_search(query_embedding, self.embeddings, top_k=3)
            return "\n---\n".join(
                self.chunks[match["corpus_id"]] for match in top_results[0]
            )
        return ""

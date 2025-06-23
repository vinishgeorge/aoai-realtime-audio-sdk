import os
from abc import ABC, abstractmethod
from langchain_community.llms.ollama import Ollama


class BaseLLMModel(ABC):
    """Abstract base class for language models."""

    @abstractmethod
    async def generate(self, prompt: str) -> str:
        """Generate a response for the given prompt."""
        raise NotImplementedError


class OllamaModel(BaseLLMModel):
    def __init__(self, base_url: str, model: str) -> None:
        self._client = Ollama(base_url=base_url, model=model)

    async def generate(self, prompt: str) -> str:
        return await self._client.apredict(prompt)


class ModelFactory:
    """Factory to create model instances."""

    @staticmethod
    def create(model_name: str | None = None) -> BaseLLMModel:
        model_name = model_name or os.getenv("LLM_PROVIDER", "ollama")
        if model_name == "ollama":
            base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
            model = os.getenv("PHI3_MODEL", "phi3.5:3.8b")
            return OllamaModel(base_url=base_url, model=model)
        raise ValueError(f"Unknown model provider: {model_name}")

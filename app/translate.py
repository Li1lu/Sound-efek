"""Japanese -> English translation for prompts, via a local OpenAI-compatible LLM."""
import re

import httpx

from app.config import settings

JAPANESE_RE = re.compile(r"[ぁ-ヿ㐀-䶿一-鿿]")

SYSTEM_PROMPT = (
    "You are a translator for a sound-effect generation AI. Translate the Japanese "
    "description of a sound effect into a concise English prompt suitable for a "
    "text-to-audio model. Output ONLY the English prompt, nothing else."
)


def needs_translation(text: str) -> bool:
    return bool(JAPANESE_RE.search(text))


async def translate_to_english(text: str) -> str:
    """Translate Japanese prompt to English. Raises httpx errors on failure."""
    payload = {
        "model": settings.llm_model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        "temperature": 0.2,
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(f"{settings.llm_url}/chat/completions", json=payload)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"].strip()


async def check_translator_ok() -> bool:
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{settings.llm_url}/models")
            return resp.status_code < 500
    except Exception:
        return False

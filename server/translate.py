import json
import os
from typing import List

import requests

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma2")
OLLAMA_TIMEOUT = int(os.getenv("OLLAMA_TIMEOUT", "60"))

SYSTEM_PROMPT = (
    "You are a professional manga translator. "
    "Translate the following Japanese text into Vietnamese. "
    "Tone: Casual, honorifics included. "
    "Do not add explanations. Return valid JSON array of translated strings only."
)


def build_prompt(lines: List[str]) -> str:
    return json.dumps({"lines": lines}, ensure_ascii=False)


def parse_response(response_text: str, count: int) -> List[str]:
    trimmed = response_text.strip()
    try:
        parsed = json.loads(trimmed)
        if isinstance(parsed, list) and len(parsed) == count:
            return [str(item).strip() for item in parsed]
    except Exception:
        pass

    fallback = [line.strip() for line in trimmed.splitlines() if line.strip()]
    if len(fallback) == count:
        return fallback

    return [trimmed]


def translate_text_blocks(lines: List[str]) -> List[str]:
    if not lines:
        return []

    payload = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_prompt(lines)},
        ],
        "temperature": 0.2,
        "max_tokens": 1100,
        "top_p": 0.9,
    }

    endpoint = f"{OLLAMA_URL}/v1/chat/completions"
    result = requests.post(endpoint, json=payload, timeout=OLLAMA_TIMEOUT)
    result.raise_for_status()
    data = result.json()

    content = data["choices"][0]["message"]["content"]
    return parse_response(content, len(lines))

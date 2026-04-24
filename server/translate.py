import json
import logging
import os
from typing import Dict, List, Optional

import requests

logger = logging.getLogger("translator_server.translate")

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma2")
OLLAMA_TIMEOUT = int(os.getenv("OLLAMA_TIMEOUT", "60"))

SYSTEM_PROMPT_BASE = (
    "You are a professional manga translator. "
    "Translate the texts below from the source language into Vietnamese. "
    "Tone: Casual, honorifics included. "
    "Preserve character names and formatting as much as possible. "
    "Do not add extra explanation or commentary. "
    "Return only the translated text for each input line."
)


def build_prompt(lines: List[str], glossary: Optional[Dict[str, str]] = None, character_names: Optional[List[str]] = None) -> str:
    prompt = [SYSTEM_PROMPT_BASE]
    if character_names:
        prompt.append(f"Character names: {', '.join(character_names)}.")
    if glossary:
        entries = ", ".join([f'"{k}" -> "{v}"' for k, v in glossary.items()])
        prompt.append(f"Use this glossary when translating: {entries}.")
    prompt.append("Translate these lines:")
    for idx, line in enumerate(lines, start=1):
        prompt.append(f"{idx}. {line}")
    prompt.append("Return the translated lines as a JSON array of strings in the same order.")
    return "\n".join(prompt)


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


TRANSLATION_MEMORY: Dict[str, str] = {}


def build_cache_key(text: str, glossary: Optional[Dict[str, str]], character_names: Optional[List[str]]) -> str:
    glossary_blob = json.dumps(glossary or {}, ensure_ascii=False, sort_keys=True)
    chars = ",".join(character_names or [])
    return f"{text}||{glossary_blob}||{chars}"


def translate_text_blocks(lines: List[str], glossary: Optional[Dict[str, str]] = None, character_names: Optional[List[str]] = None) -> List[str]:
    if not lines:
        return []

    result: List[str] = ["" for _ in lines]
    missing_lines: List[str] = []
    missing_indices: List[int] = []

    for idx, line in enumerate(lines):
        cache_key = build_cache_key(line, glossary, character_names)
        if cache_key in TRANSLATION_MEMORY:
            result[idx] = TRANSLATION_MEMORY[cache_key]
        else:
            missing_indices.append(idx)
            missing_lines.append(line)

    if missing_lines:
        payload = {
            "model": OLLAMA_MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT_BASE},
                {"role": "user", "content": build_prompt(missing_lines, glossary, character_names)},
            ],
            "temperature": 0.2,
            "max_tokens": 1100,
            "top_p": 0.9,
        }

        endpoint = f"{OLLAMA_URL}/v1/chat/completions"
        try:
            result = requests.post(endpoint, json=payload, timeout=OLLAMA_TIMEOUT)
            result.raise_for_status()
        except requests.RequestException as exc:
            logger.exception("Ollama request failed")
            raise
        data = result.json()
        content = data["choices"][0]["message"]["content"]
        translations = parse_response(content, len(missing_lines))

        for idx, translated in zip(missing_indices, translations):
            result[idx] = translated
            cache_key = build_cache_key(lines[idx], glossary, character_names)
            TRANSLATION_MEMORY[cache_key] = translated

    return result

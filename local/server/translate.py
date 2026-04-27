import json
import logging
import os
from typing import Dict, List, Optional

from env_loader import load_dotenv
import requests

load_dotenv()

logger = logging.getLogger("translator_server.translate")

LMSTUDIO_URL = os.getenv("LMSTUDIO_URL", os.getenv("OLLAMA_URL", "http://127.0.0.1:11434"))
LMSTUDIO_MODEL = os.getenv("LMSTUDIO_MODEL", os.getenv("OLLAMA_MODEL", "gemma2"))
LMSTUDIO_TIMEOUT = int(os.getenv("LMSTUDIO_TIMEOUT", os.getenv("OLLAMA_TIMEOUT", "60")))

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
        if "vl" in LMSTUDIO_MODEL.lower() or "vision" in LMSTUDIO_MODEL.lower():
            logger.warning(
                "LMStudio model %s looks like a vision-language model; this backend currently sends only text prompts.",
                LMSTUDIO_MODEL,
            )

        chat_payload = {
            "model": LMSTUDIO_MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT_BASE},
                {"role": "user", "content": build_prompt(missing_lines, glossary, character_names)},
            ],
            "temperature": 0.2,
            "max_tokens": 1100,
            "top_p": 0.9,
        }

        text_payload = {
            "model": LMSTUDIO_MODEL,
            "prompt": build_prompt(missing_lines, glossary, character_names),
            "temperature": 0.2,
            "max_tokens": 1100,
            "top_p": 0.9,
        }

        endpoints = [
            (f"{LMSTUDIO_URL}/v1/chat/completions", chat_payload),
            (f"{LMSTUDIO_URL}/v1/completions", text_payload),
            (f"{LMSTUDIO_URL}/api/generate", text_payload),
        ]
        response = None
        last_exception = None
        last_endpoint = None

        for endpoint, payload_to_send in endpoints:
            try:
                response = requests.post(endpoint, json=payload_to_send, timeout=(10, LMSTUDIO_TIMEOUT))
                if response.status_code == 404:
                    logger.warning("LMStudio endpoint not found: %s", endpoint)
                    continue
                if response.status_code >= 500:
                    logger.warning("LMStudio endpoint %s returned HTTP %s", endpoint, response.status_code)
                    last_exception = requests.HTTPError(
                        f"LMStudio endpoint {endpoint} returned HTTP {response.status_code}", response=response
                    )
                    continue
                response.raise_for_status()
                last_endpoint = endpoint
                break
            except (requests.ReadTimeout, requests.ConnectTimeout) as exc:
                last_exception = exc
                logger.warning("LMStudio endpoint timeout: %s", endpoint)
                continue
            except requests.HTTPError as exc:
                last_exception = exc
                if exc.response is not None and exc.response.status_code == 404:
                    logger.warning("LMStudio endpoint not found: %s", endpoint)
                    continue
                logger.warning("LMStudio request HTTP error on %s: %s", endpoint, exc)
                continue
            except requests.RequestException as exc:
                last_exception = exc
                logger.warning("LMStudio request failed on %s: %s", endpoint, exc)
                continue

        if response is None:
            logger.error("LMStudio request failed on all endpoints: %s", [e for e, _ in endpoints])
            if last_exception:
                raise RuntimeError(f"LMStudio request failed on all endpoints: {last_exception}") from last_exception
            raise RuntimeError("LMStudio request failed: no available endpoint")

        data = response.json()
        content = None
        if "choices" in data and data["choices"]:
            content = data["choices"][0].get("message", {}).get("content")
            if content is None and "text" in data["choices"][0]:
                content = data["choices"][0]["text"]
        elif "error" in data:
            error_detail = data["error"]
            if isinstance(error_detail, dict):
                raise ValueError(
                    f"LMStudio error from {last_endpoint}: {error_detail.get('message')} "
                    f"(type={error_detail.get('type')}, code={error_detail.get('code')})"
                )
            raise ValueError(f"LMStudio error from {last_endpoint}: {error_detail}")
        else:
            raise ValueError(f"Unexpected LMStudio response format from {last_endpoint}: {data}")

        translations = parse_response(content, len(missing_lines))

        for idx, translated in zip(missing_indices, translations):
            result[idx] = translated
            cache_key = build_cache_key(lines[idx], glossary, character_names)
            TRANSLATION_MEMORY[cache_key] = translated

    return result

import json
import logging
import os
import re
from typing import Dict, List, Optional

from env_loader import load_dotenv
import requests

load_dotenv()

logger = logging.getLogger("translator_server.translate")

LMSTUDIO_URL = os.getenv("LMSTUDIO_URL", os.getenv("OLLAMA_URL", "http://127.0.0.1:11434"))
LMSTUDIO_MODEL = os.getenv("LMSTUDIO_MODEL", os.getenv("OLLAMA_MODEL", "gemma2"))
LMSTUDIO_TIMEOUT = int(os.getenv("LMSTUDIO_TIMEOUT", os.getenv("OLLAMA_TIMEOUT", "60")))

SYSTEM_PROMPT_BASE = (
    "You are a professional manga/manhwa/manhua translator. "
    "Translate the given Chinese or Japanese text into natural Vietnamese only. "
    "Preserve tone, character names, and formatting. "
    "Do not add explanations, commentary, extra text, or the original Chinese/Japanese source. "
    "Return only the translated Vietnamese content in the requested format."
)


def build_prompt(lines: List[str], glossary: Optional[Dict[str, str]] = None, character_names: Optional[List[str]] = None) -> str:
    prompt: List[str] = []
    if character_names:
        prompt.append(f"Character names: {', '.join(character_names)}.")
    if glossary:
        entries = ", ".join([f'"{k}" -> "{v}"' for k, v in glossary.items()])
        prompt.append(f"Use this glossary when translating: {entries}.")
    prompt.append("Translate these lines (Chinese, Japanese, or English) into Vietnamese only. Return Vietnamese only, not the source text.")
    for idx, line in enumerate(lines, start=1):
        prompt.append(f"{idx}. {line}")
    prompt.append("Return the translated lines as a JSON array of strings in the same order.")
    return "\n".join(prompt)


def parse_response(response_text: str, count: int) -> List[str]:
    trimmed = response_text.strip()
    if not trimmed:
        return ["" for _ in range(count)]

    def normalize_lines(lines: List[str]) -> List[str]:
        return [line.strip() for line in lines if line.strip()]

    def strip_numbering(lines: List[str]) -> List[str]:
        stripped = [re.sub(r"^\s*\d+[\.)]?\s*", "", line).strip() for line in lines]
        return [line for line in stripped if line]

    try:
        parsed = json.loads(trimmed)
        if isinstance(parsed, list):
            normalized = [str(item).strip() for item in parsed]
            if len(normalized) == count:
                return normalized
            if len(normalized) > count:
                return normalized[:count]
            if len(normalized) == 1:
                nested = normalize_lines(str(parsed[0]).splitlines())
                if len(nested) == count:
                    return nested
    except Exception:
        pass

    array_match = re.search(r"(\[.*\])", trimmed, re.S)
    if array_match:
        try:
            parsed = json.loads(array_match.group(1))
            if isinstance(parsed, list):
                normalized = [str(item).strip() for item in parsed]
                if len(normalized) == count:
                    return normalized
                if len(normalized) > count:
                    return normalized[:count]
        except Exception:
            pass

    lines = normalize_lines(trimmed.splitlines())
    if len(lines) == count:
        return lines

    numbered = strip_numbering(lines)
    if len(numbered) == count:
        return numbered

    if len(lines) > count:
        return lines[:count]

    return [trimmed]


def extract_content_from_response(data: dict, endpoint: str) -> str:
    if not data:
        raise ValueError(f"Empty response from {endpoint}")
    if "choices" in data and data["choices"]:
        choice = data["choices"][0]
        return choice.get("message", {}).get("content") or choice.get("text") or ""
    if "output_text" in data:
        return data["output_text"]
    if "response" in data:
        return data["response"]
    if "text" in data and isinstance(data["text"], str):
        return data["text"]
    raise ValueError(f"Unexpected LMStudio/Qwen response format from {endpoint}: {data}")


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

        qwen_payload = {
            "model": LMSTUDIO_MODEL,
            "system_prompt": SYSTEM_PROMPT_BASE,
            "input": build_prompt(missing_lines, glossary, character_names),
            "temperature": 0.2,
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
            (f"{LMSTUDIO_URL}/api/v1/chat", qwen_payload),
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
        content = extract_content_from_response(data, last_endpoint)
        translations = parse_response(content, len(missing_lines))

        for idx, translated in zip(missing_indices, translations):
            result[idx] = translated
            cache_key = build_cache_key(lines[idx], glossary, character_names)
            TRANSLATION_MEMORY[cache_key] = translated

    return result

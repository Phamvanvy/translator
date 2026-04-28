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
    "You are a senior Chinese-to-Vietnamese visual novel translator. "
    "You specialize in natural, emotional dialogue that fits inside tight speech bubbles.\n"
    "Rules:\n"
    "1. NATURAL: translate into colloquial Vietnamese that matches the speaker's tone and emotion.\n"
    "2. CONCISE: the Vietnamese must be no longer than the source text — cut filler words aggressively.\n"
    "3. CONTEXT: each numbered item is one speech bubble; treat related bubbles as part of the same conversation.\n"
    "4. CLEAN: return ONLY Vietnamese text — no Chinese, no romanization, no explanations.\n"
    "5. FORMAT: return a JSON array of strings in the same order as input."
)


def build_prompt(lines: List[str], glossary: Optional[Dict[str, str]] = None, character_names: Optional[List[str]] = None) -> str:
    prompt: List[str] = []
    if character_names:
        prompt.append(f"Character names (keep as-is): {', '.join(character_names)}.")
    if glossary:
        entries = ", ".join([f'"{k}" -> "{v}"' for k, v in glossary.items()])
        prompt.append(f"Glossary (use exactly): {entries}.")
    prompt.append(
        "Translate each numbered speech bubble from Chinese into concise Vietnamese.\n"
        "- Each number = one bubble; keep translations tight to avoid overflowing the text box.\n"
        "- Prefer short natural phrases over long formal sentences.\n"
        "- If a bubble trails off (e.g. ends with '...'), preserve that feeling."
    )
    for idx, line in enumerate(lines, start=1):
        prompt.append(f"{idx}. {line}")
    prompt.append('\nReturn ONLY a JSON array of strings, same count and order. Example: ["Câu 1.", "Câu 2."]')
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


def _try_parse_json_relaxed(text: str):
    """Try json.loads first, then convert Python-repr single-quoted strings to JSON."""
    try:
        return json.loads(text)
    except Exception:
        pass
    # Replace Python single-quoted strings with double-quoted JSON.
    # Strategy: replace ' with " only around keys/values, preserving apostrophes inside values.
    # Simple but effective: replace outer single quotes on keys and on string values.
    try:
        # Replace single-quoted keys: 'key' -> "key"
        converted = re.sub(r"'([^'\\]*(?:\\.[^'\\]*)*)'", lambda m: '"' + m.group(1).replace('"', '\\"') + '"', text)
        return json.loads(converted)
    except Exception:
        pass
    return None


def parse_vision_json_response(response_text: str, count: int) -> List[str]:
    """Parse vision response that may be {"translations":[{box_id, vietnamese_text}]} or a plain JSON array.
    Returns a list of translated strings indexed 0..count-1."""
    trimmed = response_text.strip()
    # Strip markdown code fences if present
    trimmed = re.sub(r"^```[a-zA-Z]*\s*", "", trimmed)
    trimmed = re.sub(r"\s*```$", "", trimmed).strip()

    # Try structured format: {"translations": [{box_id, vietnamese_text, ...}]}
    # Handles both valid JSON (double quotes) and Python-repr (single quotes).
    data = _try_parse_json_relaxed(trimmed)
    if data and isinstance(data, dict) and "translations" in data:
        items = data["translations"]
        result: List[str] = [""] * count
        for item in items:
            bid = item.get("box_id")
            text = str(item.get("vietnamese_text", "")).strip()
            if bid is not None and 1 <= int(bid) <= count:
                result[int(bid) - 1] = text
        if any(r for r in result):
            logger.debug("Vision JSON response parsed via box_id mapping (%d/%d filled).", sum(1 for r in result if r), count)
            return result

    # If we got a JSON array of dicts (list format), try extracting vietnamese_text by position.
    if data and isinstance(data, list) and data and isinstance(data[0], dict):
        by_id: List[str] = [""] * count
        by_pos: List[str] = []
        for item in data:
            bid = item.get("box_id")
            text = str(item.get("vietnamese_text", "")).strip()
            by_pos.append(text)
            if bid is not None and 1 <= int(bid) <= count:
                by_id[int(bid) - 1] = text
        if any(r for r in by_id):
            return by_id
        if by_pos:
            return by_pos[:count]

    # Regex fallback: extract vietnamese_text values from Python-style repr strings in a list.
    # Handles: ["{'box_id': 1, 'vietnamese_text': 'Xin chào'}", ...]
    viet_values = re.findall(r"['\"]vietnamese_text['\"]\s*:\s*['\"]([^'\"]+)['\"]", trimmed)
    if viet_values:
        result = [""] * count
        # Also try to find box_id pairings
        pairs = re.findall(r"['\"]box_id['\"]\s*:\s*(\d+).*?['\"]vietnamese_text['\"]\s*:\s*['\"]([^'\"]+)['\"]", trimmed, re.S)
        if pairs and len(pairs) == len(viet_values):
            for bid_str, text in pairs:
                bid = int(bid_str)
                if 1 <= bid <= count:
                    result[bid - 1] = text.strip()
        else:
            for i, text in enumerate(viet_values[:count]):
                result[i] = text.strip()
        if any(r for r in result):
            logger.info("Vision response parsed via regex vietnamese_text extraction (%d items).", sum(1 for r in result if r))
            return result

    # Fall back to existing generic parser
    return parse_response(response_text, count)


TRANSLATION_MEMORY: Dict[str, str] = {}

CJK_RE = re.compile(r'[\u4e00-\u9fff\u3400-\u4dbf]')


def _is_untranslated(result: List[str], sources: List[str]) -> bool:
    """Return True if the model echoed the source text instead of translating."""
    cjk_count = sum(1 for r in result if r.strip() and CJK_RE.search(r))
    if cjk_count > len(result) * 0.5:
        logger.warning("Vision result looks untranslated (%d/%d items contain CJK).", cjk_count, len(result))
        return True
    identical = sum(1 for r, s in zip(result, sources) if r.strip() == s.strip())
    if identical > len(sources) * 0.5:
        logger.warning("Vision result identical to source (%d/%d items).", identical, len(sources))
        return True
    return False


def _build_vision_user_prompt(texts: List[str], glossary: Optional[Dict[str, str]], character_names: Optional[List[str]]) -> str:
    """Build the user-turn message for the vision request — avoids conflicting format instructions from build_prompt()."""
    parts: List[str] = []
    if character_names:
        parts.append(f"Tên nhân vật (giữ nguyên): {', '.join(character_names)}.")
    if glossary:
        entries = ", ".join([f'"{k}" → "{v}"' for k, v in glossary.items()])
        parts.append(f"Bảng thuật ngữ: {entries}.")
    parts.append(f"Dưới đây là {len(texts)} bong bóng thoại OCR cần DỊCH sang tiếng Việt:")
    for idx, line in enumerate(texts, start=1):
        parts.append(f"{idx}. {line}")
    parts.append(
        "\nTRẢ VỀ JSON NGAY theo định dạng system prompt. "
        "Mỗi vietnamese_text PHẢI là tiếng Việt, không chứa chữ Hán."
    )
    return "\n".join(parts)

VISION_SYSTEM_PROMPT = (
    "Bạn là chuyên gia dịch thuật Manga (Trung → Việt). Nhiệm vụ của bạn là DỊCH, không phải nhận dạng chữ.\n"
    "\n"
    "BƯỚC 1: QUÉT THỊ GIÁC\n"
    "- Nhìn vào hình ảnh, đọc TOÀN BỘ các cụm chữ tiếng Trung, kể cả chữ dọc từ phải sang trái.\n"
    "- Sửa lỗi OCR bằng cách đối chiếu với hình ảnh thực tế.\n"
    "\n"
    "BƯỚC 2: DỊCH SANG TIẾNG VIỆT\n"
    "- Bắt buộc dịch sang tiếng Việt — KHÔNG được trả về chữ Trung Quốc trong kết quả.\n"
    "- Dịch tự nhiên, súc tích. Ví dụ: '老师' → 'cô giáo', '用这个' → 'dùng cái này'.\n"
    "- Giữ '...' hoặc '!' cuối câu. Bản dịch phải ngắn gọn để khớp bong bóng thoại.\n"
    "\n"
    "BƯỚC 3: TRẢ VỀ JSON (bắt buộc, không giải thích thêm)\n"
    "{\"translations\": [{\"box_id\": 1, \"vietnamese_text\": \"<tiếng Việt>\"}]}\n"
    "box_id khớp với số thứ tự 1-based của bong bóng trong danh sách đầu vào.\n"
    "CẢNH BÁO: Nếu vietnamese_text chứa chữ Hán, kết quả sẽ bị từ chối."
)


def translate_with_vision(
    image_data: str,
    texts: List[str],
    glossary: Optional[Dict[str, str]] = None,
    character_names: Optional[List[str]] = None,
) -> List[str]:
    """Vision-enhanced translation: sends image + OCR text to the LLM so it can correct OCR errors.
    Falls back to text-only translation if the model does not support vision."""
    if not texts:
        return []

    try:
        user_prompt = _build_vision_user_prompt(texts, glossary, character_names)
        img_url = image_data if image_data.startswith("data:") else f"data:image/png;base64,{image_data}"
        max_tokens = max(2048, len(texts) * 200)

        vision_payload = {
            "model": LMSTUDIO_MODEL,
            "messages": [
                {"role": "system", "content": VISION_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": img_url}},
                        {"type": "text", "text": user_prompt},
                    ],
                },
            ],
            "temperature": 0.4,
            "max_tokens": max_tokens,
            "top_p": 0.9,
            "repeat_penalty": 1.1,
        }

        endpoint = f"{LMSTUDIO_URL}/v1/chat/completions"
        response = requests.post(endpoint, json=vision_payload, timeout=(10, LMSTUDIO_TIMEOUT))

        if response.status_code == 200:
            data = response.json()
            content = extract_content_from_response(data, endpoint)
            result = parse_vision_json_response(content, len(texts))
            if result and any(r.strip() for r in result) and not _is_untranslated(result, texts):
                logger.info("Vision-enhanced translation succeeded for %d bubbles.", len(texts))
                return result
            logger.warning("Vision translation output rejected (untranslated or echoed source) — falling back.")
        else:
            logger.warning(
                "Vision translation returned status %s — falling back to text-only.", response.status_code
            )
    except Exception as exc:
        logger.warning("Vision translation error (%s) — falling back to text-only.", exc)

    return translate_text_blocks(texts, glossary=glossary, character_names=character_names)


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

        max_tokens = max(2048, len(missing_lines) * 200)
        chat_payload = {
            "model": LMSTUDIO_MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT_BASE},
                {"role": "user", "content": build_prompt(missing_lines, glossary, character_names)},
            ],
            "temperature": 0.35,
            "max_tokens": max_tokens,
            "top_p": 0.9,
            "repeat_penalty": 1.1,
        }

        qwen_payload = {
            "model": LMSTUDIO_MODEL,
            "system_prompt": SYSTEM_PROMPT_BASE,
            "input": build_prompt(missing_lines, glossary, character_names),
            "temperature": 0.35,
            "top_p": 0.9,
            "repeat_penalty": 1.1,
        }

        text_payload = {
            "model": LMSTUDIO_MODEL,
            "prompt": build_prompt(missing_lines, glossary, character_names),
            "temperature": 0.35,
            "max_tokens": max_tokens,
            "top_p": 0.9,
            "repeat_penalty": 1.1,
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

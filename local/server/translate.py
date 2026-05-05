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


# ──────────────────────────────────────────────────────────────────────────────
# Ask / Quiz mode
# ──────────────────────────────────────────────────────────────────────────────

ASK_SYSTEM_PROMPT = (
    "Bạn là trợ lý phân tích bài trắc nghiệm / khảo sát.\n"
    "Nhìn vào hình ảnh và danh sách text blocks được đánh số 1-based.\n"
    "Một ảnh có thể chứa NHIỀU CÂU HỎI. Phân tích TẤT CẢ các câu hỏi có trong ảnh.\n"
    "Mỗi câu hỏi có thể có NHIỀU ĐÁP ÁN ĐÚNG (ví dụ: câu hỏi 'chọn tất cả đáp án đúng').\n\n"
    "Trả về JSON (không thêm gì khác ngoài JSON):\n"
    "{\n"
    "  \"questions\": [\n"
    "    {\n"
    "      \"question_text\": \"nội dung câu hỏi (copy nguyên văn)\",\n"
    "      \"question_box_ids\": [1],\n"
    "      \"answer_texts\": [\"đáp án đúng 1\", \"đáp án đúng 2\"],\n"
    "      \"answer_box_ids\": [3, 5],\n"
    "      \"explanation\": \"giải thích ngắn tại sao đáp án này đúng\"\n"
    "    }\n"
    "  ]\n"
    "}\n"
    "Quy tắc:\n"
    "- Nếu chỉ 1 câu hỏi, vẫn trả về mảng questions có 1 phần tử.\n"
    "- answer_box_ids và answer_texts phải là mảng (dù chỉ 1 đáp án).\n"
    "- Nếu câu hỏi yêu cầu chọn nhiều, liệt kê hết tất cả đáp án đúng."
)


def _parse_ask_json(text: str) -> dict:
    """Parse LLM ask response. Returns dict with 'questions' list."""
    trimmed = text.strip()
    trimmed = re.sub(r"^```[a-zA-Z]*\s*", "", trimmed)
    trimmed = re.sub(r"\s*```$", "", trimmed).strip()

    data = _try_parse_json_relaxed(trimmed)
    if not data:
        match = re.search(r"\{.*\}", trimmed, re.S)
        if match:
            data = _try_parse_json_relaxed(match.group(0))

    if not data or not isinstance(data, dict):
        return {"questions": []}

    # New multi-question format
    if "questions" in data and isinstance(data["questions"], list):
        return data

    # Backward compat: old single-question format → wrap in questions list
    if "answer_text" in data or "answer_box_ids" in data:
        q = {
            "question_text": data.get("question_text", ""),
            "question_box_ids": data.get("question_box_ids", []),
            "answer_texts": (
                [data["answer_text"]] if isinstance(data.get("answer_text"), str)
                else data.get("answer_texts", [])
            ),
            "answer_box_ids": data.get("answer_box_ids", []),
            "explanation": data.get("explanation", ""),
        }
        return {"questions": [q]}

    return {"questions": []}


def ask_question(
    image_data: str,
    text_blocks: List[dict],
    qa_context: Optional[List[dict]] = None,
) -> dict:
    """Use vision LLM to identify the correct answer in a quiz/survey image.

    Args:
        image_data: base64 data URL of the scanned image region.
        text_blocks: list of {"box": [l, t, r, b], "text": "..."} from OCR.
        qa_context: optional list of relevant Q&A pairs for context.

    Returns:
        {
            "question_text": str,
            "answer_text": str,
            "explanation": str,
            "results": [{"box", "text", "box_id", "is_answer"}, ...],
        }
    """
    if not text_blocks:
        return {"question_text": "", "answer_text": "", "explanation": "", "results": []}

    parts: List[str] = []

    if qa_context:
        parts.append("Tham khảo các câu hỏi tương tự trong cơ sở dữ liệu kiến thức:")
        for qa in qa_context:
            parts.append(f"  Q: {qa.get('question', '')}")
            parts.append(f"  A: {qa.get('answer', '')}")
            if qa.get("explanation"):
                parts.append(f"  Lý do: {qa['explanation']}")
        parts.append("")

    parts.append(f"Có {len(text_blocks)} text blocks nhận diện được trong ảnh (đánh số 1-based):")
    for idx, block in enumerate(text_blocks, 1):
        parts.append(f"  {idx}. \"{block['text']}\"")

    parts.append(
        "\nDựa vào hình ảnh và danh sách trên, xác định câu hỏi và đáp án ĐÚNG NHẤT. "
        "Trả về JSON theo format đã mô tả trong system prompt."
    )
    user_prompt = "\n".join(parts)

    img_url = image_data if image_data.startswith("data:") else f"data:image/png;base64,{image_data}"

    vision_payload = {
        "model": LMSTUDIO_MODEL,
        "messages": [
            {"role": "system", "content": ASK_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": img_url}},
                    {"type": "text", "text": user_prompt},
                ],
            },
        ],
        "temperature": 0.1,
        "max_tokens": 512,
        "top_p": 0.9,
    }

    # Text-only fallback payload (for non-vision models)
    text_payload = {
        "model": LMSTUDIO_MODEL,
        "messages": [
            {"role": "system", "content": ASK_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
        "max_tokens": 512,
        "top_p": 0.9,
    }

    parsed: dict = {"questions": []}
    endpoint = f"{LMSTUDIO_URL}/v1/chat/completions"

    for payload in (vision_payload, text_payload):
        try:
            response = requests.post(endpoint, json=payload, timeout=(10, LMSTUDIO_TIMEOUT))
            if response.status_code >= 400:
                logger.warning("Ask LLM returned HTTP %s, trying text fallback.", response.status_code)
                continue
            data = response.json()
            content = extract_content_from_response(data, endpoint)
            parsed = _parse_ask_json(content)
            if parsed.get("questions"):
                total_answers = sum(len(q.get("answer_box_ids", [])) for q in parsed["questions"])
                logger.info(
                    "Ask question parsed: %d question(s), %d answer(s) total.",
                    len(parsed["questions"]),
                    total_answers,
                )
                break
            logger.warning("Ask LLM response missing questions, trying text fallback.")
        except Exception as exc:
            logger.warning("Ask LLM call failed (%s), trying text fallback.", exc)

    # Build flat set of all answer box ids across all questions
    all_answer_ids: set = set()
    # Map box_id -> list of question indices that consider it an answer
    box_question_map: dict = {}
    for q_idx, q in enumerate(parsed.get("questions", [])):
        for raw_id in q.get("answer_box_ids", []):
            try:
                bid = int(raw_id)
                all_answer_ids.add(bid)
                box_question_map.setdefault(bid, []).append(q_idx)
            except (ValueError, TypeError):
                pass

    results = [
        {
            "box": block["box"],
            "text": block["text"],
            "box_id": idx,
            "is_answer": idx in all_answer_ids,
            "question_indices": box_question_map.get(idx, []),
        }
        for idx, block in enumerate(text_blocks, 1)
    ]

    return {
        "questions": parsed.get("questions", []),
        "results": results,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Chat / follow-up question
# ──────────────────────────────────────────────────────────────────────────────

CHAT_SYSTEM_PROMPT = (
    "Bạn là trợ lý thông minh hỗ trợ người dùng học tập và hỏi đáp.\n"
    "Khi nhận được ảnh chứa câu hỏi trắc nghiệm, hãy:\n"
    "1. Đọc kỹ câu hỏi và tất cả các đáp án.\n"
    "2. Xác định đáp án ĐÚNG và giải thích ngắn gọn lý do.\n"
    "3. Trả lời bằng tiếng Việt, rõ ràng, súc tích.\n"
    "Không cần suy luận dài dòng — trả lời thẳng vào vấn đề.\n"
)


def chat_with_model(
    message: str,
    context: str = "",
    history: Optional[List[dict]] = None,
    images: Optional[List[str]] = None,
) -> str:
    """Send a follow-up chat message to the LLM and return the reply string."""
    messages = [{"role": "system", "content": CHAT_SYSTEM_PROMPT}]

    if context:
        messages.append({
            "role": "system",
            "content": f"Ngữ cảnh câu hỏi gần nhất:\n{context}",
        })

    for turn in (history or [])[-8:]:
        role = turn.get("role", "user")
        content = turn.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})

    # Build current user message (with optional images for vision models)
    if images:
        content_parts: list = []
        for img in images:
            img_url = img if img.startswith("data:") else f"data:image/png;base64,{img}"
            content_parts.append({"type": "image_url", "image_url": {"url": img_url}})
        # Always include a text instruction; fall back to default when message is empty
        content_parts.append({"type": "text", "text": message or "Hãy đọc ảnh và trả lời câu hỏi trong ảnh. Xác định đáp án đúng và giải thích ngắn gọn bằng tiếng Việt."})
        messages.append({"role": "user", "content": content_parts})
    else:
        messages.append({"role": "user", "content": message})

    payload = {
        "model": LMSTUDIO_MODEL,
        "messages": messages,
        "temperature": 0.5,
        "max_tokens": 4096,
        "top_p": 0.9,
    }

    endpoint = f"{LMSTUDIO_URL}/v1/chat/completions"
    try:
        response = requests.post(endpoint, json=payload, timeout=(10, LMSTUDIO_TIMEOUT))
        response.raise_for_status()
        data = response.json()
        return extract_content_from_response(data, endpoint).strip()
    except Exception as exc:
        logger.warning("Chat request failed: %s", exc)
        raise RuntimeError(f"Chat request failed: {exc}") from exc


from typing import Generator


def _is_token_overflow_error(msg: str) -> bool:
    """Detect token/context overflow or jinja template errors from LM Studio."""
    m = msg.lower()
    return any(k in m for k in [
        "context_length_exceeded",
        "no user query found",
        "maximum context length",
        "too many tokens",
        "jinja template",
        "prompt is too long",
        "exceeds the model's maximum",
    ])


def chat_with_model_stream(
    message: str,
    context: str = "",
    history: Optional[List[dict]] = None,
    images: Optional[List[str]] = None,
) -> Generator[str, None, None]:
    """Stream chat response from LLM as SSE lines."""
    messages = [{"role": "system", "content": CHAT_SYSTEM_PROMPT}]

    if context:
        messages.append({
            "role": "system",
            "content": f"Ngữ cảnh câu hỏi gần nhất:\n{context}",
        })

    for turn in (history or [])[-8:]:
        role = turn.get("role", "user")
        content = turn.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})

    # Build current user message (with optional images for vision models)
    if images:
        content_parts: list = []
        for img in images:
            img_url = img if img.startswith("data:") else f"data:image/png;base64,{img}"
            content_parts.append({"type": "image_url", "image_url": {"url": img_url}})
        content_parts.append({"type": "text", "text": message or "Hãy đọc ảnh và trả lời câu hỏi trong ảnh. Xác định đáp án đúng và giải thích ngắn gọn bằng tiếng Việt."})
        messages.append({"role": "user", "content": content_parts})
    else:
        messages.append({"role": "user", "content": message})

    payload = {
        "model": LMSTUDIO_MODEL,
        "messages": messages,
        "temperature": 0.5,
        "max_tokens": 4096,
        "top_p": 0.9,
        "stream": True,
    }

    endpoint = f"{LMSTUDIO_URL}/v1/chat/completions"
    try:
        with requests.post(
            endpoint,
            json=payload,
            timeout=(10, LMSTUDIO_TIMEOUT),
            stream=True,
        ) as resp:
            # Handle non-streaming HTTP error before iterating
            if resp.status_code != 200:
                try:
                    err_data = resp.json()
                    err_obj = err_data.get("error") or {}
                    err_msg = (err_obj.get("message") if isinstance(err_obj, dict) else str(err_obj)) or f"HTTP {resp.status_code}"
                except Exception:
                    err_msg = f"HTTP {resp.status_code}"
                err_type = "token_overflow" if _is_token_overflow_error(err_msg) else "server_error"
                logger.warning("LMStudio returned %s: %s", resp.status_code, err_msg)
                yield f"data: {json.dumps({'error': err_msg, 'type': err_type})}\n\n"
                return

            for raw_line in resp.iter_lines():
                if not raw_line:
                    continue
                line = raw_line.decode("utf-8") if isinstance(raw_line, bytes) else raw_line
                if line.startswith("data:"):
                    data_str = line[5:].strip()
                    if data_str == "[DONE]":
                        yield "data: [DONE]\n\n"
                        return
                    try:
                        parsed = json.loads(data_str)
                        # Detect error chunk inside SSE stream (LM Studio error format)
                        if "error" in parsed:
                            err_obj = parsed["error"]
                            err_msg = (err_obj.get("message") if isinstance(err_obj, dict) else str(err_obj)) or "Unknown error"
                            err_type = "token_overflow" if _is_token_overflow_error(err_msg) else "server_error"
                            logger.warning("LMStudio stream error: %s", err_msg)
                            yield f"data: {json.dumps({'error': err_msg, 'type': err_type})}\n\n"
                            return
                        token = (
                            parsed.get("choices", [{}])[0]
                            .get("delta", {})
                            .get("content", "")
                        )
                        if token:
                            yield f"data: {json.dumps({'token': token})}\n\n"
                    except json.JSONDecodeError:
                        pass
    except Exception as exc:
        logger.warning("Streaming chat failed: %s", exc)
        err_msg = str(exc)
        err_type = "token_overflow" if _is_token_overflow_error(err_msg) else "server_error"
        yield f"data: {json.dumps({'error': err_msg, 'type': err_type})}\n\n"
    finally:
        yield "data: [DONE]\n\n"

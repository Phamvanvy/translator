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
    prompt.append('\nReturn ONLY a JSON array of strings, same count and order. Example: ["Sentence 1.", "Sentence 2."]')
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
        raw = choice.get("message", {}).get("content") or choice.get("text") or ""
    elif "output_text" in data:
        raw = data["output_text"]
    elif "response" in data:
        raw = data["response"]
    elif "text" in data and isinstance(data["text"], str):
        raw = data["text"]
    else:
        raise ValueError(f"Unexpected LMStudio/Qwen response format from {endpoint}: {data}")
    # Strip Qwen3 / DeepSeek thinking tokens <think>...</think>
    return re.sub(r"<think>.*?</think>", "", raw, flags=re.S).strip()


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
    # Handles: ["{'box_id': 1, 'vietnamese_text': 'Hello'}", ...]
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
        parts.append(f"Character names (keep as-is): {', '.join(character_names)}.")
    if glossary:
        entries = ", ".join([f'"{k}" → "{v}"' for k, v in glossary.items()])
        parts.append(f"Glossary: {entries}.")
    parts.append(f"Below are {len(texts)} OCR speech bubbles that must be TRANSLATED into Vietnamese:")
    for idx, line in enumerate(texts, start=1):
        parts.append(f"{idx}. {line}")
    parts.append(
        "\nRETURN JSON IMMEDIATELY in the system prompt format. "
        "Each vietnamese_text MUST be Vietnamese and contain no Chinese characters."
    )
    return "\n".join(parts)

VISION_SYSTEM_PROMPT = (
    "You are an expert Manga translator (Chinese → Vietnamese). Your task is TRANSLATION, not OCR recognition.\n"
    "\n"
    "STEP 1: VISION\n"
    "- Look at the image and read ALL Chinese text blocks, including vertical text from right to left.\n"
    "- Correct OCR errors by comparing with the actual image.\n"
    "\n"
    "STEP 2: TRANSLATE TO VIETNAMESE\n"
    "- Must translate into Vietnamese — DO NOT return Chinese characters in the result.\n"
    "- Translate naturally and concisely into Vietnamese. For example, Chinese '老师' should become a natural Vietnamese equivalent meaning 'teacher', and '用这个' should become a natural Vietnamese equivalent meaning 'use this'.\n"
    "- Keep '...' or '!' at the end. The translation must be short enough to fit the speech bubble.\n"
    "\n"
    "STEP 3: RETURN JSON (mandatory, no extra explanation)\n"
    "{\"translations\": [{\"box_id\": 1, \"vietnamese_text\": \"<Vietnamese>\"}]}\n"
    "box_id matches the 1-based order of the bubbles in the input list.\n"
    "WARNING: If vietnamese_text contains Chinese characters, the result will be rejected."
)


def _resolve_llm_settings(llm_url: Optional[str] = None, llm_model: Optional[str] = None):
    return (llm_url or LMSTUDIO_URL, llm_model or LMSTUDIO_MODEL)


def translate_with_vision(
    image_data: str,
    texts: List[str],
    glossary: Optional[Dict[str, str]] = None,
    character_names: Optional[List[str]] = None,
    llm_url: Optional[str] = None,
    llm_model: Optional[str] = None,
) -> List[str]:
    """Vision-enhanced translation: sends image + OCR text to the LLM so it can correct OCR errors.
    Falls back to text-only translation if the model does not support vision."""
    if not texts:
        return []

    try:
        llm_url, llm_model = _resolve_llm_settings(llm_url, llm_model)
        user_prompt = _build_vision_user_prompt(texts, glossary, character_names)
        img_url = image_data if image_data.startswith("data:") else f"data:image/png;base64,{image_data}"
        max_tokens = max(32768, len(texts) * 200)

        vision_payload = {
            "model": llm_model,
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

        endpoint = f"{llm_url}/v1/chat/completions"
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

    return translate_text_blocks(
        texts,
        glossary=glossary,
        character_names=character_names,
        llm_url=llm_url,
        llm_model=llm_model,
    )


def build_cache_key(text: str, glossary: Optional[Dict[str, str]], character_names: Optional[List[str]]) -> str:
    glossary_blob = json.dumps(glossary or {}, ensure_ascii=False, sort_keys=True)
    chars = ",".join(character_names or [])
    return f"{text}||{glossary_blob}||{chars}"


def translate_text_blocks(
    lines: List[str],
    glossary: Optional[Dict[str, str]] = None,
    character_names: Optional[List[str]] = None,
    llm_url: Optional[str] = None,
    llm_model: Optional[str] = None,
) -> List[str]:
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
        llm_url, llm_model = _resolve_llm_settings(llm_url, llm_model)
        if "vl" in llm_model.lower() or "vision" in llm_model.lower():
            logger.warning(
                "LLM model %s looks like a vision-language model; this backend currently sends only text prompts.",
                llm_model,
            )

        max_tokens = max(32768, len(missing_lines) * 200)
        chat_payload = {
            "model": llm_model,
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
            "model": llm_model,
            "system_prompt": SYSTEM_PROMPT_BASE,
            "input": build_prompt(missing_lines, glossary, character_names),
            "temperature": 0.35,
            "top_p": 0.9,
            "repeat_penalty": 1.1,
        }

        text_payload = {
            "model": llm_model,
            "prompt": build_prompt(missing_lines, glossary, character_names),
            "temperature": 0.35,
            "max_tokens": max_tokens,
            "top_p": 0.9,
            "repeat_penalty": 1.1,
        }

        endpoints = [
            (f"{llm_url}/v1/chat/completions", chat_payload),
            (f"{llm_url}/api/v1/chat", qwen_payload),
            (f"{llm_url}/v1/completions", text_payload),
            (f"{llm_url}/api/generate", text_payload),
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

ASK_VISION_SYSTEM_PROMPT = (
    "You are a quiz/test solver. Look at the image carefully.\n"
    "Identify ALL questions visible in the image and their CORRECT answers.\n"
    "For each correct answer option, provide its bounding box in image pixels.\n\n"
    "Return ONLY valid JSON (nothing else):\n"
    "{\n"
    "  \"questions\": [\n"
    "    {\n"
    "      \"question_text\": \"question content\",\n"
    "      \"answer_texts\": [\"correct answer 1\"],\n"
    "      \"answer_boxes\": [[left, top, right, bottom]],\n"
    "      \"explanation\": \"why this is correct\"\n"
    "    }\n"
    "  ]\n"
    "}\n"
    "Rules:\n"
    "- answer_boxes[i] is the bounding box of answer_texts[i] in image pixels (0,0 = top-left)\n"
    "- Include ALL correct answers for multi-select questions\n"
    "- Return questions as an array even if there is only 1 question\n"
    "- answer_texts and answer_boxes must always be arrays of equal length"
)


def ask_question_vision(
    image_data: str,
    qa_context: Optional[List[dict]] = None,
    llm_url: Optional[str] = None,
    llm_model: Optional[str] = None,
) -> dict:
    """Vision-only ask: sends the image directly to the LLM, no OCR required.

    The LLM reads the text from the image itself and returns the correct
    answers along with their pixel bounding boxes for auto-click.
    """
    img_url = image_data if image_data.startswith("data:") else f"data:image/png;base64,{image_data}"
    llm_url, llm_model = _resolve_llm_settings(llm_url, llm_model)

    parts: List[str] = []
    if qa_context:
        parts.append("Refer to similar questions in the knowledge base:")
        for qa in qa_context:
            parts.append(f"  Q: {qa.get('question', '')}")
            parts.append(f"  A: {qa.get('answer', '')}")
            if qa.get("explanation"):
                parts.append(f"  Reason: {qa['explanation']}")
        parts.append("")
    parts.append("Look at the image and return the correct answer(s) with bounding box coordinates. /nothink")
    user_prompt = "\n".join(parts)

    payload = {
        "model": llm_model,
        "messages": [
            {"role": "system", "content": ASK_VISION_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": img_url}},
                    {"type": "text", "text": user_prompt},
                ],
            },
        ],
        "temperature": 0.1,
        "max_tokens": 32768,
        "top_p": 0.9,
    }

    endpoint = f"{llm_url}/v1/chat/completions"
    try:
        response = requests.post(endpoint, json=payload, timeout=(10, LMSTUDIO_TIMEOUT))
        if response.status_code == 200:
            data = response.json()
            content = extract_content_from_response(data, endpoint)
            logger.info("ask_question_vision raw content (%d chars): %s", len(content), content[:300])
            parsed = _parse_ask_json(content)
            if parsed.get("questions"):
                logger.info("ask_question_vision: %d question(s) parsed.", len(parsed["questions"]))
            else:
                logger.warning("ask_question_vision: LLM response missing questions.")
        else:
            logger.warning("ask_question_vision: HTTP %s from LLM.", response.status_code)
    except Exception as exc:
        logger.warning("ask_question_vision failed: %s", exc)

    # Build results list for auto-click (one entry per answer box)
    results = []
    for q_idx, q in enumerate(parsed.get("questions", [])):
        answer_texts = q.get("answer_texts", [])
        answer_boxes = q.get("answer_boxes", [])
        for i, text in enumerate(answer_texts):
            box = answer_boxes[i] if i < len(answer_boxes) else None
            if box and len(box) == 4:
                results.append({
                    "box": [int(v) for v in box],
                    "text": text,
                    "is_answer": True,
                    "question_indices": [q_idx],
                })

    return {
        "questions": parsed.get("questions", []),
        "results": results,
    }


ASK_SYSTEM_PROMPT = (
    "You are an assistant for analyzing quiz/test problems.\n"
    "Look at the image and the numbered text blocks.\n"
    "One image may contain MULTIPLE QUESTIONS. Analyze ALL questions in the image.\n"
    "Each question may have MULTIPLE CORRECT ANSWERS (e.g. select all correct answers).\n\n"
    "Return JSON only (nothing else):\n"
    "{\n"
    "  \"questions\": [\n"
    "    {\n"
    "      \"question_text\": \"question content (copy verbatim)\",\n"
    "      \"question_box_ids\": [1],\n"
    "      \"answer_texts\": [\"correct answer 1\", \"correct answer 2\"],\n"
    "      \"answer_box_ids\": [3, 5],\n"
    "      \"explanation\": \"short explanation why this answer is correct\"\n"
    "    }\n"
    "  ]\n"
    "}\n"
    "Rules:\n"
    "- If there is only 1 question, still return questions as an array with one element.\n"
    "- answer_box_ids and answer_texts must be arrays (even if there is only 1 correct answer).\n"
    "- If a question requires multiple selections, list all correct answers."
)


def _parse_ask_json(text: str) -> dict:
    """Parse LLM ask response. Returns dict with 'questions' list."""
    trimmed = text.strip()
    # Strip thinking tokens (Qwen3, DeepSeek-R1, etc.)
    trimmed = re.sub(r"<think>.*?</think>", "", trimmed, flags=re.S).strip()
    # Strip markdown code fences
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
    llm_url: Optional[str] = None,
    llm_model: Optional[str] = None,
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
        parts.append("Refer to similar questions in the knowledge base:")
        for qa in qa_context:
            parts.append(f"  Q: {qa.get('question', '')}")
            parts.append(f"  A: {qa.get('answer', '')}")
            if qa.get("explanation"):
                parts.append(f"  Reason: {qa['explanation']}")
        parts.append("")

    parts.append(f"There are {len(text_blocks)} text blocks detected in the image (numbered 1-based):")
    for idx, block in enumerate(text_blocks, 1):
        parts.append(f"  {idx}. \"{block['text']}\"")

    parts.append(
        "\nBased on the image and the list above, determine the MOST CORRECT question and answer. "
        "Return JSON in the format described in the system prompt."
    )
    user_prompt = "\n".join(parts)

    img_url = image_data if image_data.startswith("data:") else f"data:image/png;base64,{image_data}"

    llm_url, llm_model = _resolve_llm_settings(llm_url, llm_model)
    vision_payload = {
        "model": llm_model,
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
        "max_tokens": 32768,
        "top_p": 0.9,
    }

    # Text-only fallback payload (for non-vision models)
    text_payload = {
        "model": llm_model,
        "messages": [
            {"role": "system", "content": ASK_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
        "max_tokens": 32768,
        "top_p": 0.9,
    }

    parsed: dict = {"questions": []}
    endpoint = f"{llm_url}/v1/chat/completions"

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
# Autonomous agent step
# ──────────────────────────────────────────────────────────────────────────────

AGENT_SYSTEM_PROMPT = (
    "You are an AI agent controlling a web browser to complete tasks for the user.\n"
    "\n"
    "You receive:\n"
    "1. A screenshot of the current viewport\n"
    "2. A list of visible interactive elements (tag, text, x, y) — use these for precise coordinates\n"
    "3. Your recent action history — do NOT repeat the same action consecutively\n"
    "\n"
    "Return ONLY valid JSON — no markdown, no extra text:\n"
    '  Click:       {"action": "click",      "x": 320, "y": 450, "reason": "..."}\n'
    '  Type text:   {"action": "type",       "x": 320, "y": 450, "text": "...", "reason": "..."}\n'
    '  Press key:   {"action": "press_key",  "key": "Enter", "reason": "..."}\n'
    '  Scroll down: {"action": "scroll_down","reason": "..."}\n'
    '  Scroll up:   {"action": "scroll_up",  "reason": "..."}\n'
    '  Done:        {"action": "done",       "reason": "..."}\n'
    "\n"
    "Decision rules (follow in priority order):\n"
    "1. Prefer the element list over screenshot for locating click targets.\n"
    "2. Unanswered question visible → click the CORRECT answer.\n"
    "3. All answers selected and Next/Submit/Continue visible → click it.\n"
    "4. Input field needs filling → use type action.\n"
    "5. Need more content → scroll_down (or scroll_up if you overshot).\n"
    "6. Task fully done or nothing actionable remains → done."
)

AGENT_PLAN_PROMPT = (
    "You are an AI browser agent. Analyze the current page and output a concise execution plan.\n"
    "\n"
    "You receive a screenshot and list of visible interactive elements.\n"
    "Return ONLY valid JSON:\n"
    '{"plan": ["Step 1: ...", "Step 2: ..."], "reason": "Brief overview"}\n'
    "\n"
    "Keep it concise (max 8 steps). Only describe what you can infer from the current view."
)


def agent_step(
    image_data: str,
    viewport_width: int = 1280,
    viewport_height: int = 720,
    step_history: Optional[List[dict]] = None,
    dom_context: Optional[List[dict]] = None,
    task: str = "",
    mode: str = "act",
    llm_url: Optional[str] = None,
    llm_model: Optional[str] = None,
) -> dict:
    """Given a screenshot of the current viewport, ask the LLM what action to take next.

    mode='act'  → returns {"action": "click"|"type"|"press_key"|"scroll_down"|"scroll_up"|"done", ...}
    mode='plan' → returns {"plan": [...], "reason": "..."}
    """
    llm_url, llm_model = _resolve_llm_settings(llm_url, llm_model)
    img_url = image_data if image_data.startswith("data:") else f"data:image/png;base64,{image_data}"

    system_prompt = AGENT_PLAN_PROMPT if mode == "plan" else AGENT_SYSTEM_PROMPT

    # Build user text
    text_parts: List[str] = []
    if task:
        text_parts.append(f"TASK: {task}\n")
    text_parts.append(f"Viewport: {viewport_width}x{viewport_height} px")
    if dom_context:
        text_parts.append(f"\nVisible interactive elements ({min(len(dom_context), 50)} shown):")
        for i, el in enumerate(dom_context[:50], 1):
            text_parts.append(f"  {i}. [{el.get('tag','')}] \"{el.get('text','')}\" at ({el.get('x',0)}, {el.get('y',0)})")
    if mode == "plan":
        text_parts.append("\nOutput your execution plan as JSON.")
    else:
        if step_history:
            text_parts.append("\nPrevious steps taken:")
            for i, entry in enumerate(step_history[-5:], 1):
                text_parts.append(f"  {i}. {json.dumps(entry, ensure_ascii=False)}")
        text_parts.append("\nDecide the single best next action. Return only JSON.")
    user_text = "\n".join(text_parts)

    user_parts = [
        {"type": "image_url", "image_url": {"url": img_url}},
        {"type": "text", "text": user_text + "\n/nothink"},
    ]

    messages: List[dict] = [{"role": "system", "content": system_prompt}]
    messages.append({"role": "user", "content": user_parts})

    max_tokens = 32768

    payload = {
        "model": llm_model,
        "messages": messages,
        "temperature": 0.1,
        "max_tokens": max_tokens,
        "top_p": 0.9,
    }

    endpoint = f"{llm_url}/v1/chat/completions"
    try:
        for attempt in range(2):
            response = requests.post(endpoint, json=payload, timeout=(10, LMSTUDIO_TIMEOUT))
            response.raise_for_status()
            content = extract_content_from_response(response.json(), endpoint)
            logger.info("Agent raw content attempt %d (%d chars): %s", attempt + 1, len(content), content[:300])
            if content:
                break
            logger.warning("Agent got empty content on attempt %d, retrying...", attempt + 1)
        content = re.sub(r"^```[a-zA-Z]*\s*", "", content.strip())
        content = re.sub(r"\s*```$", "", content).strip()
        # Fix LLM forgetting "y": key — pattern: "x": 123, "456" → "x": 123, "y": 456
        content = re.sub(r'("x"\s*:\s*[\d.]+)\s*,\s*"(\d+)"', r'\1, "y": \2', content)
        m = re.search(r"\{.*\}", content, re.S)
        if m:
            content = m.group(0)
        parsed = _try_parse_json_relaxed(content)
        if not parsed:
            raise ValueError(f"Could not parse agent JSON: {content[:120]}")

        if mode == "plan":
            plan = parsed.get("plan", [])
            logger.info("Agent plan: %d steps", len(plan))
            return {"plan": plan, "reason": str(parsed.get("reason", ""))}

        action = parsed.get("action", "done")
        result: dict = {"action": action, "reason": str(parsed.get("reason", ""))}
        if action in ("click", "type"):
            def _to_int(v):
                if isinstance(v, list):
                    v = sum(v) / len(v) if v else 0
                return int(float(v))
            result["x"] = _to_int(parsed.get("x", 0))
            result["y"] = _to_int(parsed.get("y", 0))
        if action == "type":
            result["text"] = str(parsed.get("text", ""))
        if action == "press_key":
            result["key"] = str(parsed.get("key", "Enter"))
        logger.info("Agent step: action=%s reason=%s", action, result["reason"])
        return result
    except Exception as exc:
        logger.warning("Agent step failed: %s", exc)
        return {"action": "done", "reason": f"Error: {exc}"}




CHAT_SYSTEM_PROMPT = (
    "You are an intelligent assistant helping the user with study and question answering.\n"
    "When you receive an image containing multiple-choice questions, do the following:\n"
    "1. Read the question and all answer choices carefully.\n"
    "2. Identify the CORRECT answer and explain briefly why.\n"
    "3. Answer in Vietnamese clearly and concisely.\n"
    "No long-winded reasoning needed — answer directly.\n"
)


def chat_with_model(
    message: str,
    context: str = "",
    history: Optional[List[dict]] = None,
    images: Optional[List[str]] = None,
    llm_url: Optional[str] = None,
    llm_model: Optional[str] = None,
) -> str:
    """Send a follow-up chat message to the LLM and return the reply string."""
    messages = [{"role": "system", "content": CHAT_SYSTEM_PROMPT}]

    if context:
        messages.append({
            "role": "system",
            "content": f"Most recent question context:\n{context}",
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
        _chat_text = (message or "Please read the image and answer the question in the image. Identify the correct answer and explain briefly in Vietnamese.") + " /nothink"
        content_parts.append({"type": "text", "text": _chat_text})
        messages.append({"role": "user", "content": content_parts})
    else:
        messages.append({"role": "user", "content": message + " /nothink"})

    llm_url, llm_model = _resolve_llm_settings(llm_url, llm_model)
    payload = {
        "model": llm_model,
        "messages": messages,
        "temperature": 0.5,
        "max_tokens": 32768,
        "top_p": 0.9,
    }

    endpoint = f"{llm_url}/v1/chat/completions"
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
    llm_url: Optional[str] = None,
    llm_model: Optional[str] = None,
) -> Generator[str, None, None]:
    """Stream chat response from LLM as SSE lines."""
    messages = [{"role": "system", "content": CHAT_SYSTEM_PROMPT}]

    if context:
        messages.append({
            "role": "system",
            "content": f"Most recent question context:\n{context}",
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
        _chat_text = (message or "Please read the image and answer the question in the image. Identify the correct answer and explain briefly in Vietnamese.") + " /nothink"
        content_parts.append({"type": "text", "text": _chat_text})
        messages.append({"role": "user", "content": content_parts})
    else:
        messages.append({"role": "user", "content": message + " /nothink"})

    llm_url, llm_model = _resolve_llm_settings(llm_url, llm_model)
    payload = {
        "model": llm_model,
        "messages": messages,
        "temperature": 0.5,
        "max_tokens": 32768,
        "top_p": 0.9,
        "stream": True,
    }

    endpoint = f"{llm_url}/v1/chat/completions"
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

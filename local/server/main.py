import base64
import logging
import re
from typing import List

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from typing import Dict, List, Optional

from glossary_store import get_glossary, update_glossary
from ocr import decode_image, merge_text_lines, ocr_image, inpaint_text_regions
from qa_store import add_qa_entry, find_relevant_qa, get_all_qa, remove_qa_entry
from translate import ask_question, chat_with_model, chat_with_model_stream, translate_text_blocks, translate_with_vision

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("translator_server")

app = FastAPI(title="AutoScan Manga Translator", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": str(exc.detail) if exc.detail else "HTTP error"},
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled server error")
    return JSONResponse(
        status_code=500,
        content={
            "error": "Internal server error",
            "detail": str(exc),
        },
    )


class HealthResponse(BaseModel):
    status: str


class TranslateRequest(BaseModel):
    lines: List[str]


class ImageTranslateRequest(BaseModel):
    image: str
    lang: str = "japan"
    glossary: Optional[Dict[str, str]] = None
    character_names: Optional[List[str]] = None
    domain_id: Optional[str] = None
    tab_id: Optional[int] = None


class AskRequest(BaseModel):
    image: str
    lang: str = "ch"
    domain_id: Optional[str] = None


class QAEntryRequest(BaseModel):
    question: str
    answer: str
    explanation: str = ""


class ChatRequest(BaseModel):
    message: str
    context: str = ""
    history: Optional[List[dict]] = None
    images: Optional[List[str]] = None  # list of base64 data URLs for vision


def encode_image_to_data_url(image: np.ndarray) -> str:
    success, buffer = cv2.imencode('.png', image)
    if not success:
        raise ValueError('Failed to encode image.')
    return f"data:image/png;base64,{base64.b64encode(buffer).decode('utf-8')}"


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/api/ocr")
def api_ocr(request: ImageTranslateRequest):
    try:
        image = decode_image(request.image)
        lines = ocr_image(image, lang=request.lang)
        merged = merge_text_lines(lines)
        return {"lines": merged}
    except Exception as exc:
        logger.exception("OCR request failed")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/translate")
def api_translate(request: TranslateRequest):
    try:
        translations = translate_text_blocks(request.lines)
        return {"translations": translations}
    except Exception as exc:
        logger.exception("Translate request failed")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/translate-image")
def api_translate_image(request: ImageTranslateRequest):
    try:
        image = decode_image(request.image)
        lines = ocr_image(image, lang=request.lang)
        merged = merge_text_lines(lines)

        stored_glossary = get_glossary(request.domain_id)
        if request.domain_id and request.glossary:
            stored_glossary = update_glossary(request.domain_id, request.glossary)
        merged_glossary = {**stored_glossary, **(request.glossary or {})}

        texts = [item["text"] for item in merged]
        translations = translate_with_vision(
            request.image,
            texts,
            glossary=merged_glossary,
            character_names=request.character_names,
        )

        if len(translations) != len(merged) and translations:
            candidate = [
                re.sub(r"^\s*\d+[\.)]?\s*", "", line).strip()
                for line in translations[0].splitlines()
                if line.strip()
            ]
            if len(candidate) == len(merged):
                translations = candidate
                logger.warning(
                    "Adjusted translation count from %d to %d using split fallback.",
                    len(translations),
                    len(merged),
                )

        payload = []
        for index, item in enumerate(merged):
            translated = translations[index] if index < len(translations) else ""
            left, top, right, bottom = item["box"]
            width = right - left
            height = bottom - top
            payload.append(
                {
                    "box": [left, top, right, bottom],
                    "polygons": item["polygons"],
                    "text": item["text"],
                    "translation": translated,
                    "writing_mode": "vertical-rl" if height / max(width, 1) > 1.5 else "horizontal-tb",
                }
            )
        result = {"results": payload}
        return result
    except Exception as exc:
        logger.exception("Translate-image request failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ──────────────────────────────────────────────────────────────────────────────
# Ask / Quiz endpoint
# ──────────────────────────────────────────────────────────────────────────────

@app.post("/api/ask")
def api_ask(request: AskRequest):
    """Scan an image containing a quiz/survey question and return the correct answer."""
    try:
        image = decode_image(request.image)
        lines = ocr_image(image, lang=request.lang)
        merged = merge_text_lines(lines)

        text_blocks = [{"box": item["box"], "text": item["text"]} for item in merged]

        all_text = " ".join(b["text"] for b in text_blocks)
        qa_context = find_relevant_qa(all_text, top_k=5) if text_blocks else []

        result = ask_question(request.image, text_blocks, qa_context)
        return result
    except Exception as exc:
        logger.exception("Ask request failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ──────────────────────────────────────────────────────────────────────────────
# Q&A Knowledge Base CRUD
# ──────────────────────────────────────────────────────────────────────────────

@app.get("/api/qa")
def api_list_qa():
    """List all Q&A entries in the knowledge base."""
    return {"qa": get_all_qa()}


@app.post("/api/qa")
def api_add_qa(entry: QAEntryRequest):
    """Add a new Q&A pair to the knowledge base."""
    if not entry.question.strip() or not entry.answer.strip():
        raise HTTPException(status_code=400, detail="question and answer must not be empty")
    added = add_qa_entry(entry.question, entry.answer, entry.explanation)
    return {"qa": added}


@app.delete("/api/qa/{qa_id}")
def api_delete_qa(qa_id: int):
    """Delete a Q&A entry by its ID."""
    success = remove_qa_entry(qa_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Q&A entry {qa_id} not found")
    return {"success": True}


# ──────────────────────────────────────────────────────────────────────────────
# Chat endpoint
# ──────────────────────────────────────────────────────────────────────────────

@app.post("/api/chat")
def api_chat(request: ChatRequest):
    """Follow-up chat with the LLM, optionally using Q&A context."""
    if not request.message.strip() and not request.images:
        raise HTTPException(status_code=400, detail="message or images must not be empty")
    try:
        reply = chat_with_model(
            message=request.message,
            context=request.context,
            history=request.history,
            images=request.images,
        )
        return {"reply": reply}
    except Exception as exc:
        logger.exception("Chat request failed")
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/chat/stream")
def api_chat_stream(request: ChatRequest):
    """Stream chat response via SSE."""
    if not request.message.strip() and not request.images:
        raise HTTPException(status_code=400, detail="message or images must not be empty")
    return StreamingResponse(
        chat_with_model_stream(
            message=request.message,
            context=request.context,
            history=request.history,
            images=request.images,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

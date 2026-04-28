import base64
import logging
import re
from typing import List

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Dict, List, Optional

from glossary_store import get_glossary, update_glossary
from ocr import decode_image, merge_text_lines, ocr_image, inpaint_text_regions
from translate import translate_text_blocks

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("translator_server")

app = FastAPI(title="AutoScan Manga Translator", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
        translations = translate_text_blocks(
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
                    "box": [left, top, width, height],
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

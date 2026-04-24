import base64
from typing import List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from ocr import decode_image, merge_text_lines, ocr_image
from translate import translate_text_blocks

app = FastAPI(title="AutoScan Manga Translator", version="0.1.0")


class HealthResponse(BaseModel):
    status: str


class TranslateRequest(BaseModel):
    lines: List[str]


class ImageTranslateRequest(BaseModel):
    image: str
    lang: str = "japan"


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
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/translate")
def api_translate(request: TranslateRequest):
    try:
        translations = translate_text_blocks(request.lines)
        return {"translations": translations}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/translate-image")
def api_translate_image(request: ImageTranslateRequest):
    try:
        image = decode_image(request.image)
        lines = ocr_image(image, lang=request.lang)
        merged = merge_text_lines(lines)
        texts = [item["text"] for item in merged]
        translations = translate_text_blocks(texts)
        payload = []
        for item, translated in zip(merged, translations):
            payload.append(
                {
                    "box": item["box"],
                    "text": item["text"],
                    "translation": translated,
                }
            )
        return {"results": payload}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

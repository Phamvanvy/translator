import base64
import io
import os
from typing import Dict, List

# Disable MKL-DNN/oneDNN optimizations for PaddlePaddle on some CPU builds
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("FLAGS_allocator_strategy", "auto_growth")

import cv2
import numpy as np
from PIL import Image

try:
    from paddleocr import PaddleOCR
except ImportError as exc:
    raise ImportError(
        "PaddleOCR requires paddlepaddle. Install it with `pip install paddlepaddle` "
        "or see README.md for environment instructions."
    ) from exc

OCR_LANG_DEFAULT = os.getenv("PADDLE_OCR_LANG", "japan")
_ocr_models: Dict[str, PaddleOCR] = {}


def get_ocr_model(lang: str = OCR_LANG_DEFAULT) -> PaddleOCR:
    lang = lang or OCR_LANG_DEFAULT
    if lang not in _ocr_models:
        _ocr_models[lang] = PaddleOCR(use_angle_cls=True, lang=lang, use_gpu=False)
    return _ocr_models[lang]


def decode_image(data_url: str) -> np.ndarray:
    if data_url.startswith("data:"):
        data_url = data_url.split(",", 1)[1]
    image_bytes = base64.b64decode(data_url)
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    return cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)


def ocr_image(image: np.ndarray, lang: str = OCR_LANG_DEFAULT) -> List[Dict]:
    model = get_ocr_model(lang)
    try:
        results = model.ocr(image, cls=True)
    except TypeError:
        try:
            results = model.ocr(image)
        except TypeError:
            results = model.ocr(image, det=True, rec=True)
    lines = []

    for line in results:
        if len(line) < 2:
            continue
        box, text_score = line
        text, score = text_score
        if not text or score < 0.3:
            continue

        xs = [int(pt[0]) for pt in box]
        ys = [int(pt[1]) for pt in box]
        left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
        polygon = [[int(pt[0]), int(pt[1])] for pt in box]
        lines.append({
            "text": text.strip(),
            "confidence": float(score),
            "box": [left, top, right, bottom],
            "polygon": polygon,
            "left": left,
            "top": top,
            "right": right,
            "bottom": bottom,
            "mid_y": (top + bottom) / 2,
            "height": bottom - top,
        })

    return lines


def merge_text_lines(lines: List[Dict]) -> List[Dict]:
    if not lines:
        return []

    sorted_lines = sorted(lines, key=lambda item: (item["mid_y"], item["left"]))
    groups: List[Dict] = []

    for line in sorted_lines:
        inserted = False
        for group in groups:
            y_distance = abs(line["mid_y"] - group["mid_y"])
            threshold = max(24, group["height"] * 0.6)
            if y_distance <= threshold:
                group["lines"].append(line)
                group["top"] = min(group["top"], line["top"])
                group["bottom"] = max(group["bottom"], line["bottom"])
                group["left"] = min(group["left"], line["left"])
                group["right"] = max(group["right"], line["right"])
                group["polygons"].append(line["polygon"])
                group["mid_y"] = (group["top"] + group["bottom"]) / 2
                group["height"] = group["bottom"] - group["top"]
                inserted = True
                break

        if not inserted:
            groups.append({
                "lines": [line],
                "top": line["top"],
                "bottom": line["bottom"],
                "left": line["left"],
                "right": line["right"],
                "polygons": [line["polygon"]],
                "mid_y": line["mid_y"],
                "height": line["height"],
            })

    merged: List[Dict] = []
    for group in groups:
        ordered = sorted(group["lines"], key=lambda item: item["left"])
        text = " ".join([item["text"] for item in ordered])
        merged.append({
            "text": text.strip(),
            "box": [group["left"], group["top"], group["right"], group["bottom"]],
            "polygons": group["polygons"],
        })

    return merged


def inpaint_text_regions(image: np.ndarray, polygons: List[List[List[int]]]) -> np.ndarray:
    if image is None or len(polygons) == 0:
        return image

    mask = np.zeros(image.shape[:2], dtype=np.uint8)
    for polygon_group in polygons:
        for polygon in polygon_group:
            pts = np.array(polygon, dtype=np.int32)
            if pts.size == 0:
                continue
            cv2.fillPoly(mask, [pts], 255)

    if not np.any(mask):
        return image

    return cv2.inpaint(image, mask, 3, cv2.INPAINT_TELEA)

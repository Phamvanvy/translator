import base64
import inspect
import io
import os
from typing import Dict, List

from env_loader import load_dotenv

load_dotenv()

# Disable MKL-DNN/oneDNN optimizations for PaddlePaddle on some CPU builds.
# Also force PaddleX model cache into the local project directory instead of the user's C:\ drive.
project_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
project_cache_dir = os.path.join(project_dir, ".paddlex")
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", project_cache_dir)
os.makedirs(os.environ["PADDLE_PDX_CACHE_HOME"], exist_ok=True)
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("FLAGS_enable_mkldnn", "0")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")
os.environ.setdefault("PADDLE_DISABLE_ONE_DNN", "1")
os.environ.setdefault("PADDLE_WITH_MKLDNN", "0")
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


def build_paddleocr_kwargs(**kwargs) -> Dict[str, object]:
    signature = inspect.signature(PaddleOCR.__init__)
    supported = {
        name: value
        for name, value in kwargs.items()
        if name in signature.parameters and name != "self"
    }

    if "use_gpu" in kwargs and "use_gpu" not in supported:
        if "device" in signature.parameters:
            supported["device"] = "gpu" if kwargs["use_gpu"] else "cpu"

    return supported


def get_ocr_model(lang: str = OCR_LANG_DEFAULT) -> PaddleOCR:
    lang = lang or OCR_LANG_DEFAULT
    if lang not in _ocr_models:
        model_kwargs = build_paddleocr_kwargs(use_angle_cls=True, lang=lang, use_gpu=False)
        _ocr_models[lang] = PaddleOCR(**model_kwargs)
    return _ocr_models[lang]


def decode_image(data_url: str) -> np.ndarray:
    if data_url.startswith("data:"):
        data_url = data_url.split(",", 1)[1]
    image_bytes = base64.b64decode(data_url)
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    return cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)


def _normalize_ocr_result(result) -> List[Dict]:
    if hasattr(result, "get"):
        result = dict(result)

    if isinstance(result, dict):
        rec_texts = result.get("rec_texts", [])
        rec_scores = result.get("rec_scores", [])
        rec_boxes = result.get("rec_boxes", [])
        rec_polys = result.get("rec_polys", [])

        normalized = []
        for idx, text in enumerate(rec_texts):
            score = float(rec_scores[idx]) if idx < len(rec_scores) else 0.0
            box = rec_boxes[idx] if idx < len(rec_boxes) else None
            if box is None and idx < len(rec_polys):
                box = rec_polys[idx]

            normalized.append({"box": box, "text": text, "score": score})
        return normalized

    if isinstance(result, (list, tuple)) and len(result) == 2:
        box, text_score = result
        if isinstance(text_score, (list, tuple)) and len(text_score) == 2:
            text, score = text_score
            return [{"box": box, "text": text, "score": float(score)}]

    return []


def _extract_box(box):
    if box is None:
        return None
    if isinstance(box, np.ndarray):
        box = box.tolist()
    if isinstance(box, dict):
        return [box.get("left"), box.get("top"), box.get("right"), box.get("bottom")]
    if isinstance(box, list) and len(box) >= 4 and all(isinstance(pt, (int, float)) for pt in box[:4]):
        # Flat box format [left, top, right, bottom]
        return [int(box[0]), int(box[1]), int(box[2]), int(box[3])]

    coords = []
    for pt in box:
        if isinstance(pt, (list, tuple)) and len(pt) >= 2:
            coords.append((int(pt[0]), int(pt[1])))
    if not coords:
        return None
    xs = [x for x, _ in coords]
    ys = [y for _, y in coords]
    return [min(xs), min(ys), max(xs), max(ys)]


def ocr_image(image: np.ndarray, lang: str = OCR_LANG_DEFAULT) -> List[Dict]:
    model = get_ocr_model(lang)
    try:
        results = model.predict(image)
    except AttributeError:
        try:
            results = model.ocr(image)
        except Exception as err:
            raise RuntimeError("PaddleOCR model does not support predict() or ocr()") from err
    except Exception:
        try:
            results = model.ocr(image)
        except Exception as err:
            raise

    lines = []
    for item in results:
        normalized_items = _normalize_ocr_result(item)
        for record in normalized_items:
            text = str(record.get("text", "")).strip()
            score = float(record.get("score", 0.0))
            box = record.get("box")
            if not text or score < 0.1:
                continue
            extracted = _extract_box(box)
            if not extracted:
                continue
            left, top, right, bottom = extracted
            polygon = []
            if isinstance(box, list) and box and isinstance(box[0], (list, tuple)):
                polygon = [[int(pt[0]), int(pt[1])] for pt in box]
            else:
                polygon = [[left, top], [right, top], [right, bottom], [left, bottom]]
            width = right - left
            height = bottom - top
            lines.append({
                "text": text,
                "confidence": score,
                "box": [left, top, right, bottom],
                "polygon": polygon,
                "left": left,
                "top": top,
                "right": right,
                "bottom": bottom,
                "mid_x": (left + right) / 2,
                "mid_y": (top + bottom) / 2,
                "width": width,
                "height": height,
            })

    return lines


def merge_text_lines(lines: List[Dict]) -> List[Dict]:
    if not lines:
        return []

    vertical_lines = [line for line in lines if line["height"] / max(line["width"], 1) > 1.4]
    if len(vertical_lines) < len(lines) * 0.5:
        vertical_lines = [
            line
            for line in lines
            if line["height"] >= line["width"] and line["height"] / max(line["width"], 1) > 0.8
        ]
    use_vertical_grouping = len(vertical_lines) >= len(lines) * 0.5

    if use_vertical_grouping:
        sorted_lines = sorted(lines, key=lambda item: (item["mid_x"], item["top"]))
        groups: List[Dict] = []

        for line in sorted_lines:
            inserted = False
            for group in groups:
                x_distance = abs(line["mid_x"] - group["mid_x"])
                threshold = max(20, (group["width"] + line["width"]) * 0.25)
                if x_distance <= threshold:
                    group["lines"].append(line)
                    group["top"] = min(group["top"], line["top"])
                    group["bottom"] = max(group["bottom"], line["bottom"])
                    group["left"] = min(group["left"], line["left"])
                    group["right"] = max(group["right"], line["right"])
                    group["polygons"].append(line["polygon"])
                    group["width"] = group["right"] - group["left"]
                    group["height"] = group["bottom"] - group["top"]
                    group["mid_x"] = (group["left"] + group["right"]) / 2
                    inserted = True
                    break

            if not inserted:
                groups.append({
                    "lines": [line],
                    "top": line["top"],
                    "bottom": line["bottom"],
                    "left": line["left"],
                    "right": line["right"],
                    "mid_x": line["mid_x"],
                    "polygons": [line["polygon"]],
                    "width": line["width"],
                    "height": line["height"],
                })

        merged: List[Dict] = []
        for group in groups:
            ordered = sorted(group["lines"], key=lambda item: item["top"])
            text = "".join([item["text"] for item in ordered])
            merged.append({
                "text": text.strip(),
                "box": [group["left"], group["top"], group["right"], group["bottom"]],
                "polygons": group["polygons"],
            })

        return merged

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
        if not polygon_group:
            continue
        for polygon in polygon_group:
            pts = np.array(polygon, dtype=np.int32)
            if pts.size == 0:
                continue
            cv2.fillPoly(mask, [pts], 255)

    if not np.any(mask):
        return image

    kernel = np.ones((5, 5), dtype=np.uint8)
    mask = cv2.dilate(mask, kernel, iterations=1)

    try:
        return cv2.inpaint(image, mask, 3, cv2.INPAINT_TELEA)
    except Exception:
        return cv2.inpaint(image, mask, 3, cv2.INPAINT_NS)

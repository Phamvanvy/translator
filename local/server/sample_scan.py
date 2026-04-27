import argparse
import base64
import io
import sys
from pathlib import Path

import pyautogui
import requests
from PIL import Image

DEFAULT_SERVER = "http://127.0.0.1:8000"


def image_to_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    content = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return f"data:image/png;base64,{content}"


def capture_region(region):
    image = pyautogui.screenshot(region=region)
    return image


def main():
    parser = argparse.ArgumentParser(description="Auto-scan sample: screenshot -> OCR -> Ollama translate")
    parser.add_argument("--server", default=DEFAULT_SERVER, help="Local server URL")
    parser.add_argument("--lang", default="japan", help="PaddleOCR language code")
    parser.add_argument("--region", nargs=4, type=int, metavar=("LEFT","TOP","WIDTH","HEIGHT"), help="Screen region to capture")
    args = parser.parse_args()

    if args.region:
        region = tuple(args.region)
    else:
        screen_width, screen_height = pyautogui.size()
        region = (0, 0, screen_width, screen_height)

    print(f"Capturing region: {region}")
    image = capture_region(region)
    payload = {"image": image_to_data_url(image), "lang": args.lang}

    url = f"{args.server.rstrip('/')}/api/translate-image"
    response = requests.post(url, json=payload, timeout=60)
    response.raise_for_status()
    data = response.json()

    print("Translation results:")
    for item in data.get("results", []):
        box = item.get("box", [])
        print(f"- Box={box}: {item.get('translation')}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("Error:", exc, file=sys.stderr)
        sys.exit(1)

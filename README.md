# Manga AutoScan Translator

Một bản demo kiến trúc Auto-scan dịch truyện tranh bằng Chrome Extension + Local Server + Ollama.

## Kiến trúc

- `Extension` (Chrome/MV3): theo dõi ảnh, chụp vùng hiển thị, gửi ảnh lên server, hiển thị overlay dịch.
- `Local Server` (Python/FastAPI): xử lý OCR, ghép text line và gọi Ollama.
- `Translation Backend` (Ollama/Gemma): dịch từ tiếng Nhật sang tiếng Việt.

## Chạy thử

1. Tạo môi trường Python và cài thư viện:

```powershell
cd d:\repos\translator\server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

> Nếu server báo lỗi thiếu `paddlepaddle`, hãy cài thủ công:
>
> ```powershell
> pip install paddlepaddle
> ```
>
> Trên Windows, nếu cài trực tiếp bị lỗi, xem hướng dẫn cài `paddlepaddle` chính thức từ trang PaddlePaddle.

2. Chạy server:

```powershell
uvicorn main:app --reload
```

3. Chạy demo OCR với ngôn ngữ tùy chọn:

```powershell
python sample_scan.py --lang japan
python sample_scan.py --lang korean
python sample_scan.py --lang en
python sample_scan.py --lang ch
```

Hoặc đặt biến môi trường:

```powershell
$env:PADDLE_OCR_LANG = "japan"
uvicorn main:app --reload
```

4. Cài extension Chrome từ thư mục `extension`.

5. Nếu muốn chọn vùng cụ thể, nhấn nút `Chọn vùng quét` trong extension rồi kéo thả vùng mong muốn.

6. Bật Auto-scan bằng `Alt+S`.

## Notes

- `server/ocr.py` dùng `PaddleOCR` để nhận diện chữ.
- `server/translate.py` gọi Ollama local API.
- `extension/content.js` dùng `IntersectionObserver` và debounce để chụp ảnh tự động.
- `extension/background.js` dùng `chrome.tabs.captureVisibleTab` để lấy ảnh chất lượng cao.

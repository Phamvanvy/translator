# Manga AutoScan Translator

Một bản demo kiến trúc Auto-scan dịch truyện tranh bằng Chrome Extension + Local Server + LMStudio.

## Kiến trúc

- `Extension` (Chrome/MV3): theo dõi ảnh, chụp vùng hiển thị, gửi ảnh lên server, hiển thị overlay dịch.
- `Local Server` (Python/FastAPI): xử lý OCR, ghép text line và gọi LMStudio.
- `Translation Backend` (LMStudio/Gemma): dịch từ tiếng Nhật sang tiếng Việt.

## Chạy thử

1. Tạo môi trường Python và cài thư viện:

```powershell
cd d:\repos\translator\server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

> Mặc định, PaddleX model cache sẽ được lưu trong `server\.paddlex` để tránh tải về `C:\Users\...`.
> Nếu muốn dùng thư mục khác, đặt `PADDLE_PDX_CACHE_HOME` trước khi chạy server.
>
> ```powershell
> $env:PADDLE_PDX_CACHE_HOME = "D:\repos\translator\server\.paddlex"
> ```
>
> Nếu server báo lỗi thiếu `paddlepaddle`, hãy cài thủ công:
>
> ```powershell
> pip install paddlepaddle
> ```
>
> Trên Windows, nếu cài trực tiếp bị lỗi, xem hướng dẫn cài `paddlepaddle` chính thức từ trang PaddlePaddle.
>
> Lưu ý: nếu bạn dùng model vision-language như `qwen3-vl`, backend hiện tại chỉ gửi prompt text, nên model đó có thể lỗi 500 nếu không cấu hình payload ảnh đúng.

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

4a. Nếu bạn muốn dùng phiên bản browser-only, cài extension từ `browser/extension` thay vì `extension`.

5. Nếu muốn chọn vùng cụ thể, nhấn nút `Chọn vùng quét` trong extension rồi kéo thả vùng mong muốn.

### Cấu hình LMStudio

Nếu dùng LMStudio, đặt các biến môi trường sau trước khi chạy server:

```powershell
$env:LMSTUDIO_URL = "http://localhost:1234"
$env:LMSTUDIO_MODEL = "qwen3.5-27b-claude-4.6-opus-reasoning-distilled-heretic-v2-i1"
```

6. Nếu muốn chọn ngôn ngữ OCR trong menu extension, mặc định là `japan`.

6. Chọn ngôn ngữ OCR trong menu extension, mặc định là `japan`.

7. Bật Auto-scan bằng `Alt+S`.

## Notes

- `server/ocr.py` dùng `PaddleOCR` để nhận diện chữ.
- `server/translate.py` gọi LMStudio local API.
- `extension/content.js` dùng `IntersectionObserver` và debounce để chụp ảnh tự động.
- `extension/background.js` dùng `chrome.tabs.captureVisibleTab` để lấy ảnh chất lượng cao.

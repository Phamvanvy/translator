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

4b. Browser-only extension hiện dùng Tesseract.js để nhận diện chữ ngay trong trình duyệt.
- `LMStudio` (local) để gọi endpoint tại `localhost:1234`
- `DeepL` để gọi API cloud DeepL
- `Google` để gọi Google Translate API

5. Nếu muốn chọn vùng cụ thể, nhấn nút `Chọn vùng quét` trong extension rồi kéo thả vùng mong muốn.

### Cấu hình LMStudio

Nếu dùng LMStudio, đặt các biến môi trường sau trước khi chạy server:

```powershell
$env:LMSTUDIO_URL = "http://localhost:1234"
$env:LMSTUDIO_MODEL = "qwen3.5-27b-claude-4.6-opus-reasoning-distilled-heretic-v2-i1"
```

### Cấu hình browser-only backend

Trong `browser/extension`, mở menu extension và bấm `Backend` để chọn:
- `LMStudio` để gọi local LMStudio
- `DeepL` để gọi API DeepL
- `Google` để gọi Google Translate API

Khi chọn `DeepL` hoặc `Google`, extension sẽ yêu cầu nhập API key phù hợp.

### Cấu hình browser-only OCR

Extension giờ dùng Tesseract.js để OCR trong trình duyệt. Nếu bạn muốn tránh tải model từ mạng, hãy đặt file `jpn.traineddata` vào `browser/extension/tesseract/`.

Nếu không có file này trong extension, Tesseract sẽ cố gắng tải model từ `https://tessdata.projectnaptha.com/4.0.0`.

6. Nếu muốn chọn ngôn ngữ OCR trong menu extension, mặc định là `japan`.

6. Chọn ngôn ngữ OCR trong menu extension, mặc định là `japan`.

7. Bật Auto-scan bằng `Alt+S`.

## Notes

- `server/ocr.py` dùng `PaddleOCR` để nhận diện chữ.
- `server/translate.py` gọi LMStudio local API.
- `extension/content.js` dùng `IntersectionObserver` và debounce để chụp ảnh tự động.
- `extension/background.js` dùng `chrome.tabs.captureVisibleTab` để lấy ảnh chất lượng cao.

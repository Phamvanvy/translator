# Manga AutoScan Translator

Một bản demo kiến trúc Auto-scan dịch truyện tranh bằng Chrome Extension + Local Server + LMStudio.

## Kiến trúc

- `local/server`: FastAPI server xử lý OCR, ghép text line, quản lý glossary và gọi LMStudio hoặc backend dịch.
- `local/server/extension`: Chrome/MV3 extension dùng local server để gửi ảnh và hiển thị overlay dịch.
- `browser/extension`: Browser-only extension dùng Tesseract.js OCR trong trình duyệt và có thể gọi LMStudio/DeepL/Google.

## Chạy thử

1. Tạo môi trường Python và cài thư viện:

```powershell
cd d:\repos\translator\local\server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

> Mặc định, PaddleX model cache sẽ được lưu trong `local/server/.paddlex` để tránh tải về `C:\Users\...`.
> Nếu muốn dùng thư mục khác, đặt `PADDLE_PDX_CACHE_HOME` trước khi chạy server.
>
> ```powershell
> $env:PADDLE_PDX_CACHE_HOME = "D:\repos\translator\local\server\.paddlex"
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
python -m uvicorn main:app --reload
```

> Nếu `uvicorn` launcher báo lỗi do venv bị trỏ sai đường dẫn, lệnh trên sẽ dùng trực tiếp Python của môi trường hiện tại.

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
python -m uvicorn main:app --reload
```

4. Cài extension Chrome từ `local/server/extension`.

5. Nếu bạn muốn dùng phiên bản browser-only, cài extension từ `browser/extension` thay vì `local/server/extension`.

6. Browser-only extension dùng Tesseract.js để nhận diện chữ ngay trong trình duyệt.
- `LMStudio` (local) để gọi endpoint tại `http://localhost:1234`
- `DeepL` để gọi API cloud DeepL
- `Google` để gọi Google Translate API

7. Nếu muốn chọn vùng cụ thể, nhấn nút `Chọn vùng quét` trong extension rồi kéo thả vùng mong muốn.

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

Browser-only extension dùng Tesseract.js để OCR trong trình duyệt. Nếu bạn muốn tránh tải model từ mạng, hãy đặt file `jpn.traineddata` vào `browser/extension/tesseract/`.

Nếu không có file này trong extension, Tesseract sẽ cố gắng tải model từ `https://tessdata.projectnaptha.com/4.0.0`.

8. Nếu muốn chọn ngôn ngữ OCR trong menu extension, mặc định là `japan`.

9. Bật Auto-scan bằng `Alt+S`.

## Notes

- `local/server/ocr.py` dùng `PaddleOCR` để nhận diện chữ.
- `local/server/translate.py` gọi LMStudio local API (dịch + ask).
- `local/server/qa_store.py` lưu Q&A knowledge base vào `qa_knowledge.json`.
- `local/server/extension/content.js` dùng `IntersectionObserver` và debounce để chụp ảnh tự động.
- `local/server/extension/background.js` dùng `chrome.tabs.captureVisibleTab` để lấy ảnh chất lượng cao.
- `browser/extension/content.js` và `browser/extension/tesseract` hỗ trợ OCR trong trình duyệt.

---

## Tính năng Hỏi đáp (Ask / Quiz Mode)

### Tổng quan

Ngoài chế độ dịch ảnh, extension hỗ trợ thêm chế độ **Hỏi đáp** — scan ảnh chứa câu hỏi trắc nghiệm (bài kiểm tra, khảo sát, v.v.), gửi đến LM Studio, và nhận về đáp án đúng được **khoanh đỏ** trực tiếp trên màn hình.

### Cách dùng

**Bước 1: Chọn chế độ**

Mở menu extension (nhấn vào nút 🔎 ở góc dưới phải), sau đó nhấn nút **❓ Hỏi đáp** để chuyển sang chế độ Ask. Nút sẽ sáng xanh khi được chọn.

**Bước 2: Chọn vùng (tùy chọn)**

Nhấn **Select Region** và kéo thả để khoanh vùng câu hỏi trên màn hình.

**Bước 3: Scan**

Nhấn **Start Scan**. Extension sẽ:
1. Chụp ảnh vùng đã chọn
2. OCR nhận diện toàn bộ text
3. Gửi đến LM Studio với prompt nhận diện câu hỏi + đáp án
4. Hiển thị:
   - **Khung đỏ** bao quanh đáp án đúng
   - **Panel kết quả** phía dưới vùng scan: câu hỏi + đáp án + giải thích

**Bước 4: Quản lý Q&A Knowledge Base (tùy chọn)**

Để cải thiện độ chính xác, bạn có thể lưu sẵn các câu hỏi và đáp án. Nhấn nút **Q&A Database** trong menu:

- **Tùy chọn 1**: Thêm câu hỏi mới (nhập câu hỏi → đáp án → giải thích)
- **Tùy chọn 2**: Xem số lượng câu hỏi đã lưu
- **Tùy chọn 3**: Xóa câu hỏi theo ID

Hoặc quản lý trực tiếp qua API (Swagger UI tại `http://localhost:8000/docs`):

```bash
# Thêm câu hỏi
curl -X POST http://localhost:8000/api/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "Câu hỏi?", "answer": "Đáp án đúng", "explanation": "Vì..."}'

# Xem danh sách
curl http://localhost:8000/api/qa

# Xóa theo ID
curl -X DELETE http://localhost:8000/api/qa/1
```

### API endpoint mới

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| `POST` | `/api/ask` | Scan ảnh, trả về đáp án đúng |
| `GET` | `/api/qa` | Lấy toàn bộ Q&A knowledge base |
| `POST` | `/api/qa` | Thêm Q&A entry mới |
| `DELETE` | `/api/qa/{id}` | Xóa Q&A entry theo ID |

### Response `/api/ask`

```json
{
  "question_text": "Bạn nên làm gì nếu máy tính bị nhiễm virus?",
  "answer_text": "Tắt máy hoặc ngắt mạng (Wifi hoặc mạng LAN)",
  "explanation": "Ngắt kết nối mạng ngay lập tức để ngăn virus lây lan.",
  "results": [
    { "box": [10, 20, 400, 50], "text": "Câu hỏi...", "box_id": 1, "is_answer": false },
    { "box": [10, 60, 400, 90], "text": "Tắt máy hoặc ngắt mạng...", "box_id": 2, "is_answer": true }
  ]
}
```

### Yêu cầu model

Chế độ Ask dùng vision LLM để xem cả ảnh lẫn text. Model trong `.env` nên hỗ trợ vision:

```env
LMSTUDIO_MODEL=qwen3.5-9b-vlm
```

Nếu model không hỗ trợ vision, server sẽ tự fallback sang text-only prompt.

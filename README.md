# Manga AutoScan Translator

A demo architecture for automatic manga translation using Chrome Extension + Local Server + LMStudio.

## Architecture

- `local/server`: FastAPI server that handles OCR, text line merging, glossary management, and calls LMStudio or a translation backend.
- `local/server/extension`: Chrome/MV3 extension that uses the local server to send images and display a translation overlay.
- `browser/extension`: Browser-only extension that uses Tesseract.js OCR in the browser and can call LMStudio/DeepL/Google.

## Quick start

1. Create a Python environment and install dependencies:

```powershell
cd e:\repos\translator\local\server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

> By default, the PaddleX model cache will be stored in `local/server/.paddlex` to avoid downloading to `C:\Users\...`.
> If you want to use another folder, set `PADDLE_PDX_CACHE_HOME` before starting the server.
>
> ```powershell
> $env:PADDLE_PDX_CACHE_HOME = "E:\repos\translator\local\server\.paddlex"
> ```
>
> If the server reports missing `paddlepaddle`, install it manually:
>
> ```powershell
> pip install paddlepaddle
> ```
>
> On Windows, if direct install fails, check the official PaddlePaddle installation guide.
>
> Note: if you use a vision-language model such as `qwen3-vl`, the current backend only sends prompt text, so that model may return HTTP 500 if the image payload is not configured correctly.

2. Run the server:

```powershell
python -m uvicorn main:app --reload
```

> If the `uvicorn` launcher reports an error due to the venv path being wrong, the command above will use the current Python directly.

3. Run the OCR demo with an optional language:

```powershell
python sample_scan.py --lang japan
python sample_scan.py --lang korean
python sample_scan.py --lang en
python sample_scan.py --lang ch
```

Or set the environment variable:

```powershell
$env:PADDLE_OCR_LANG = "japan"
python -m uvicorn main:app --reload
```

4. Install the Chrome extension from `local/server/extension`.

5. If you prefer the browser-only version, install the extension from `browser/extension` instead of `local/server/extension`.

6. The browser-only extension uses Tesseract.js for OCR inside the browser.
- `LMStudio` (local) calls the endpoint at `http://localhost:1234`
- `DeepL` calls the DeepL cloud API
- `Google` calls the Google Translate API

7. To select a specific region, click `Select Region` in the extension and drag the desired area.

### LMStudio configuration

If you use LMStudio, set these environment variables before starting the server:

```powershell
$env:LMSTUDIO_URL = "http://localhost:1234"
$env:LMSTUDIO_MODEL = "qwen3.5-27b-claude-4.6-opus-reasoning-distilled-heretic-v2-i1"
```

### Browser-only backend configuration

In `browser/extension`, open the extension menu and click `Backend` to choose:
- `LMStudio` to call local LMStudio
- `DeepL` to call the DeepL API
- `Google` to call the Google Translate API

When selecting `DeepL` or `Google`, the extension will ask for the appropriate API key.

### Browser-only OCR configuration

The browser-only extension uses Tesseract.js for OCR in the browser. If you want to avoid downloading models over the network, place `jpn.traineddata` into `browser/extension/tesseract/`.

If that file is not present in the extension, Tesseract will try to download the model from `https://tessdata.projectnaptha.com/4.0.0`.

8. To choose OCR language in the extension menu, the default is `japan`.

9. Enable Auto-scan with `Alt+S`.

## Notes

- `local/server/ocr.py` uses `PaddleOCR` to recognize text.
- `local/server/translate.py` calls the local LMStudio API (translate + ask).
- `local/server/qa_store.py` stores the Q&A knowledge base in `qa_knowledge.json`.
- `local/server/extension/content.js` uses `IntersectionObserver` and debounce to capture images automatically.
- `local/server/extension/background.js` uses `chrome.tabs.captureVisibleTab` to capture high-quality images.
- `browser/extension/content.js` and `browser/extension/tesseract` support OCR in the browser.

---

## Ask / Quiz Mode

### Overview

In addition to image translation, the extension also supports **Ask mode** — scan images containing multiple-choice questions, send them to LM Studio, and display the correct answer highlighted directly on screen.

### How to use

**Step 1: Choose a mode**

Open the extension menu (click the 🔎 button at the bottom right), then click **❓ Ask** to switch to Ask mode. The button lights up blue when selected.

**Step 2: Select a region (optional)**

Click **Select Region** and drag to crop the question area on the screen.

**Step 3: Scan**

Click **Start Scan**. The extension will:
1. Capture the selected area
2. OCR the recognized text
3. Send it to LM Studio with a prompt to identify the question and answer
4. Display:
   - a **red box** around the correct answer
   - a **results panel** below the scan area with the question, answer, and explanation

**Step 4: Manage Q&A Knowledge Base (optional)**

To improve accuracy, you can pre-store questions and answers. Click **Q&A Database** in the menu:

- **Option 1**: Add a new question (enter question → answer → explanation)
- **Option 2**: View the number of saved questions
- **Option 3**: Delete a question by ID

Or manage it directly via the API (Swagger UI at `http://localhost:8000/docs`):

```bash
# Add question
curl -X POST http://localhost:8000/api/qa \
  -H "Content-Type: application/json" \
  -d '{"question": "Question?", "answer": "Correct answer", "explanation": "Because..."}'

# List questions
curl http://localhost:8000/api/qa

# Delete by ID
curl -X DELETE http://localhost:8000/api/qa/1
```

### New API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/ask` | Scan an image and return the correct answer |
| `GET` | `/api/qa` | Retrieve the full Q&A knowledge base |
| `POST` | `/api/qa` | Add a new Q&A entry |
| `DELETE` | `/api/qa/{id}` | Delete a Q&A entry by ID |

### Response `/api/ask`

```json
{
  "question_text": "What should you do if your computer is infected with a virus?",
  "answer_text": "Turn off the machine or disconnect from the network (Wi-Fi or LAN)",
  "explanation": "Disconnect immediately to prevent the virus from spreading.",
  "results": [
    { "box": [10, 20, 400, 50], "text": "Question...", "box_id": 1, "is_answer": false },
    { "box": [10, 60, 400, 90], "text": "Turn off the machine or disconnect...", "box_id": 2, "is_answer": true }
  ]
}
```

### Model requirements

Ask mode uses a vision LLM to understand both image and text. The model in `.env` should support vision:

```env
LMSTUDIO_MODEL=qwen3.5-9b-vlm
```

If the model does not support vision, the server will fall back to a text-only prompt.

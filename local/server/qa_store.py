import json
import logging
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger("translator_server.qa_store")

QA_FILE = Path(__file__).resolve().parent / "qa_knowledge.json"


def _load() -> List[Dict]:
    if not QA_FILE.exists():
        return []
    try:
        with QA_FILE.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        logger.warning("Failed to load qa_knowledge.json, starting empty.")
        return []


def _save(qa_list: List[Dict]) -> None:
    try:
        with QA_FILE.open("w", encoding="utf-8") as f:
            json.dump(qa_list, f, ensure_ascii=False, indent=2)
    except Exception:
        logger.exception("Failed to save qa_knowledge.json")


def get_all_qa() -> List[Dict]:
    return _load()


def add_qa_entry(question: str, answer: str, explanation: str = "") -> Dict:
    qa_list = _load()
    next_id = max((e.get("id", 0) for e in qa_list), default=0) + 1
    entry: Dict = {
        "id": next_id,
        "question": question.strip(),
        "answer": answer.strip(),
        "explanation": explanation.strip(),
    }
    qa_list.append(entry)
    _save(qa_list)
    return entry


def remove_qa_entry(qa_id: int) -> bool:
    qa_list = _load()
    new_list = [e for e in qa_list if e.get("id") != qa_id]
    if len(new_list) == len(qa_list):
        return False
    _save(new_list)
    return True


def find_relevant_qa(question_text: str, top_k: int = 5) -> List[Dict]:
    """Return Q&A entries most relevant to the given text using simple keyword matching."""
    qa_list = _load()
    if not qa_list:
        return []

    q_lower = question_text.lower()
    words = [w for w in q_lower.split() if len(w) > 2]

    scored: List[tuple] = []
    for entry in qa_list:
        entry_q = entry.get("question", "").lower()
        score = sum(1 for w in words if w in entry_q)
        # Bonus for longer substring matches
        for length in range(12, 4, -1):
            found = False
            for i in range(len(q_lower) - length + 1):
                substr = q_lower[i : i + length]
                if substr in entry_q:
                    score += 3
                    found = True
                    break
            if found:
                break
        if score > 0:
            scored.append((score, entry))

    scored.sort(key=lambda x: -x[0])
    return [e for _, e in scored[:top_k]]

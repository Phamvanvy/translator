import json
from pathlib import Path
from typing import Dict, Optional

STORE_PATH = Path(__file__).resolve().parent / "glossary_store.json"


def _load_store() -> Dict[str, Dict[str, str]]:
    if not STORE_PATH.exists():
        return {}
    try:
        with STORE_PATH.open("r", encoding="utf-8") as stream:
            return json.load(stream)
    except Exception:
        return {}


def _save_store(store: Dict[str, Dict[str, str]]) -> None:
    try:
        with STORE_PATH.open("w", encoding="utf-8") as stream:
            json.dump(store, stream, ensure_ascii=False, indent=2)
    except Exception:
        pass


def get_glossary(domain_id: Optional[str]) -> Dict[str, str]:
    if not domain_id:
        return {}
    store = _load_store()
    return store.get(domain_id, {})


def update_glossary(domain_id: Optional[str], glossary: Optional[Dict[str, str]]) -> Dict[str, str]:
    if not domain_id or not glossary:
        return get_glossary(domain_id)
    store = _load_store()
    current = store.get(domain_id, {}) or {}
    merged = current.copy()
    merged.update(glossary)
    store[domain_id] = merged
    _save_store(store)
    return merged

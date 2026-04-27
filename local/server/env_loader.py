import os
from pathlib import Path


def load_dotenv(dotenv_path: str | Path | None = None) -> None:
    path = Path(dotenv_path) if dotenv_path else Path(__file__).resolve().parent / ".env"
    if not path.exists() or not path.is_file():
        return

    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if not key:
                continue
            if (value.startswith('"') and value.endswith('"')) or (
                value.startswith("'") and value.endswith("'")
            ):
                value = value[1:-1]
            os.environ.setdefault(key, value)

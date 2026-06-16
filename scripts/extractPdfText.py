import json
import sys
from pathlib import Path

from pypdf import PdfReader

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def extract_pdf(path):
    reader = PdfReader(str(path))
    pages = []
    for index, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception as exc:
            text = f"[Text extraction failed on page {index}: {exc}]"
        cleaned = "\n".join(line.strip() for line in text.splitlines() if line.strip())
        pages.append({"page": index, "text": cleaned})
    return {"pageCount": len(reader.pages), "pages": pages}


if __name__ == "__main__":
    input_path = Path(sys.argv[1])
    print(json.dumps(extract_pdf(input_path), ensure_ascii=False))

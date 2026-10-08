"""Write the kinds registry as JSON for the frontend unit tests.

    python scripts/dump_kinds.py
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from cadence.kinds import all_kinds  # noqa: E402

TARGET = ROOT / "frontend" / "tests" / "fixtures" / "kinds.json"

if __name__ == "__main__":
    TARGET.write_text(json.dumps([k.to_public() for k in all_kinds()], indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {TARGET}")

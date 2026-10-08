"""Online backup of the SQLite database.

    python -m cadence.backup [--db PATH] [--dest DIR] [--keep 30]

Uses SQLite's online backup API, so it is safe while the app is running.
Writes ``cadence-YYYYMMDD-HHMMSS.sqlite3`` into DEST, verifies it, keeps the
newest KEEP backups and exits non-zero on any failure.
"""

from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from .db import default_db_path

NAME = re.compile(r"^cadence-\d{8}-\d{6}(-\d+)?\.sqlite3$")
DEFAULT_DEST = Path(__file__).resolve().parent.parent / "backups"


def backup(db: Path, dest: Path, keep: int = 30, now: datetime | None = None) -> Path:
    if not db.is_file():
        raise FileNotFoundError(f"database not found: {db}")
    if keep < 1:
        raise ValueError("keep must be at least 1")
    dest.mkdir(parents=True, exist_ok=True)
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    target = dest / f"cadence-{stamp}.sqlite3"
    n = 1
    while target.exists():
        target = dest / f"cadence-{stamp}-{n}.sqlite3"
        n += 1
    partial = target.with_name(target.name + ".partial")
    # Open read-only through a URI so a typo never creates an empty database.
    src = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=30)
    try:
        out = sqlite3.connect(partial)
        try:
            src.backup(out, pages=256, sleep=0.01)
            # Make the copy a self-contained single file.
            out.execute("PRAGMA journal_mode = DELETE")
            result = out.execute("PRAGMA integrity_check").fetchone()[0]
            if result != "ok":
                raise RuntimeError(f"backup failed integrity check: {result}")
        finally:
            out.close()
    finally:
        src.close()
    os.replace(partial, target)
    prune(dest, keep)
    return target


def prune(dest: Path, keep: int) -> list[Path]:
    backups = sorted((p for p in dest.iterdir() if NAME.match(p.name)), key=lambda p: p.name, reverse=True)
    removed = []
    for old in backups[keep:]:
        old.unlink()
        removed.append(old)
    for stale in dest.glob("cadence-*.sqlite3.partial"):
        stale.unlink(missing_ok=True)
    return removed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m cadence.backup", description=__doc__.split("\n\n")[0])
    parser.add_argument("--db", type=Path, default=default_db_path())
    parser.add_argument("--dest", type=Path, default=Path(os.environ.get("CADENCE_BACKUP_DIR") or DEFAULT_DEST))
    parser.add_argument("--keep", type=int, default=30)
    args = parser.parse_args(argv)
    os.umask(0o077)  # backups are as private as the database
    try:
        path = backup(args.db, args.dest, args.keep)
    except Exception as exc:  # noqa: BLE001 - report any failure and exit non-zero
        print(f"backup FAILED: {exc}", file=sys.stderr)
        return 1
    print(f"backup written: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Full-backup export: one zip with everything.

- ``cadence.sqlite3``: a consistent copy made with SQLite's online backup API
- ``data.json``: every table as JSON (encrypted kinds as ciphertext only)
- ``documents/<kind>/<folders>/<title>.md``: readable copies of exportable kinds
"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import zipfile
from pathlib import Path

from . import clock
from .export import _sources_lookup, markdown_for_backup, safe_filename
from .kinds import all_kinds, get_kind
from .library import folder_path

README = """Cadence full backup
===================

cadence.sqlite3  The whole database. To restore, stop Cadence and put this file
                 where CADENCE_DB points (by default data/cadence.sqlite3).
data.json        The same data as JSON.
documents/       Markdown copies of every exportable document, by kind and folder.

Encrypted kinds (the diary) are only present as ciphertext. You need your
passphrase to read them, in Cadence or with the diary's decrypted export.
"""

TABLES = ["folders", "documents", "snapshots", "inbox", "sessions"]
OPTIONAL_TABLES = ["vaults", "sources", "clips", "clip_documents", "draft_sets", "draft_set_items"]


def _rows(conn: sqlite3.Connection, table: str) -> list[dict]:
    try:
        return [dict(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY id")]
    except sqlite3.OperationalError:
        try:
            return [dict(r) for r in conn.execute(f"SELECT * FROM {table}")]
        except sqlite3.OperationalError:
            return []


def build(db_path: Path, conn: sqlite3.Connection) -> Path:
    """Write the zip to a temporary file and return its path (caller deletes)."""
    fd, zip_name = tempfile.mkstemp(prefix="cadence-export-", suffix=".zip")
    os.close(fd)
    with tempfile.TemporaryDirectory(prefix="cadence-export-") as tmp:
        copy = Path(tmp) / "cadence.sqlite3"
        src = sqlite3.connect(f"{Path(db_path).resolve().as_uri()}?mode=ro", uri=True)
        try:
            dst = sqlite3.connect(copy)
            try:
                src.backup(dst)
                dst.execute("PRAGMA journal_mode = DELETE")
            finally:
                dst.close()
        finally:
            src.close()

        data = {
            "exported_at": clock.iso(),
            "kinds": [k.to_public() for k in all_kinds()],
        }
        for table in TABLES + OPTIONAL_TABLES:
            rows = _rows(conn, table)
            if table == "documents":
                for r in rows:
                    kind = get_kind(r["kind"])
                    if kind is None or kind.encrypted:
                        r["plain_text"] = ""  # never present, but be explicit
            data[table] = rows

        sources = _sources_lookup(conn)
        used: set[str] = set()
        with zipfile.ZipFile(zip_name, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.write(copy, "cadence.sqlite3")
            zf.writestr("data.json", json.dumps(data, ensure_ascii=False, indent=1))
            zf.writestr("README.txt", README)
            for row in conn.execute("SELECT * FROM documents WHERE deleted_at IS NULL ORDER BY kind, folder_id, sort_order, id"):
                md = markdown_for_backup(conn, row, sources)
                if md is None:
                    continue
                parts = [safe_filename(row["kind"])] + [safe_filename(f["name"]) for f in folder_path(conn, row["folder_id"])]
                base = f"{row['sort_order'] + 1:03d} {safe_filename(row['title'] or 'Untitled')}"
                path = "/".join(["documents", *parts, base]) + ".md"
                n = 2
                while path in used:
                    path = "/".join(["documents", *parts, f"{base} ({n})"]) + ".md"
                    n += 1
                used.add(path)
                zf.writestr(path, md)
    return Path(zip_name)

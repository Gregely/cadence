"""Full-text search over documents, scoped to a kind by default."""

from __future__ import annotations

import re
import sqlite3

from .errors import Invalid
from .kinds import get_kind, searchable_kind_ids
from .library import folder_path, require_kind

# Snippet markers: private-use characters the client turns into <mark>.
HIT_START = ""
HIT_END = ""

TOKEN = re.compile(r"\w+", re.UNICODE)


def fts_query(q: str) -> str | None:
    """Turn user input into a safe FTS5 query: all words, last one as a prefix."""
    tokens = TOKEN.findall(q or "")[:12]
    if not tokens:
        return None
    parts = [f'"{t}"' for t in tokens]
    parts[-1] += "*"
    return " ".join(parts)


def search(
    conn: sqlite3.Connection,
    q: str,
    *,
    kind_id: str | None = None,
    all_kinds: bool = False,
    limit: int = 30,
    folder_id: int | None = None,
) -> list[dict]:
    if all_kinds:
        kinds = [k for k in searchable_kind_ids() if not get_kind(k).encrypted]
    else:
        if not kind_id:
            raise Invalid("search needs a kind, or all_kinds=true")
        kind = require_kind(kind_id)
        if not kind.searchable or kind.encrypted:
            raise Invalid(f"{kind.label} is not searchable")
        kinds = [kind.id]
    match = fts_query(q)
    if match is None or not kinds:
        return []
    limit = max(1, min(int(limit), 100))
    marks = ",".join("?" * len(kinds))
    scope_sql, scope_params = "", []
    if folder_id is not None:
        # Only documents inside this folder, at any depth.
        scope_sql = (
            " AND d.folder_id IN (WITH RECURSIVE sub(id) AS ("
            " SELECT id FROM folders WHERE id = ? AND deleted_at IS NULL"
            " UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id WHERE f.deleted_at IS NULL)"
            " SELECT id FROM sub)"
        )
        scope_params = [folder_id]
    rows = conn.execute(
        f"""
        SELECT d.id, d.kind, d.title, d.folder_id, d.status, d.updated_at, d.role,
               snippet(documents_fts, 1, ?, ?, '…', 14) AS snippet,
               highlight(documents_fts, 0, ?, ?) AS title_hit
        FROM documents_fts
        JOIN documents d ON d.id = documents_fts.rowid
        WHERE documents_fts MATCH ?
          AND d.deleted_at IS NULL
          AND d.kind IN ({marks}){scope_sql}
        ORDER BY bm25(documents_fts, 4.0, 1.0)
        LIMIT ?
        """,
        (HIT_START, HIT_END, HIT_START, HIT_END, match, *kinds, *scope_params, limit),
    ).fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "kind": r["kind"],
                "title": r["title"],
                "title_hit": r["title_hit"],
                "status": r["status"],
                "updated_at": r["updated_at"],
                "snippet": r["snippet"],
                "folder_path": [p["name"] for p in folder_path(conn, r["folder_id"])],
                "folder_id": r["folder_id"],
                "role": r["role"],
            }
        )
    return out

"""Research tools: sources, clipped quotes and reading notes.

Available to documents of any kind whose registry entry enables the
research pane (essays, out of the box).
"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any

from . import clock
from .errors import Forbidden, Invalid, NotFound
from .kinds import get_kind, searchable_kind_ids
from .library import create_document, doc_row, folder_path, require_kind, tx
from .search import search as fts_search

LIMITS = {"title": 300, "author": 200, "url": 2000, "published": 60, "notes": 4000, "quote": 10000, "page": 40, "note": 2000}
URL_OK = re.compile(r"^(https?://\S+)?$", re.I)


def _text(p: dict, key: str, required: bool = False) -> str:
    value = p.get(key, "")
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise Invalid(f"{key} must be text")
    value = value.strip() if key not in ("quote", "notes", "note") else value.strip("\n ")
    if key not in ("quote", "notes", "note"):
        value = " ".join(value.split())
    if required and not value:
        raise Invalid(f"{key} is required")
    if len(value) > LIMITS[key]:
        raise Invalid(f"{key} is too long")
    if key == "url" and not URL_OK.match(value):
        raise Invalid("url must start with http:// or https://")
    return value


def _source_dict(row: sqlite3.Row, clips: int | None = None) -> dict:
    out = {k: row[k] for k in ("id", "title", "author", "url", "published", "notes", "created_at", "updated_at")}
    if clips is not None:
        out["clip_count"] = clips
    return out


def _clip_dict(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    docs = [r[0] for r in conn.execute("SELECT document_id FROM clip_documents WHERE clip_id = ? ORDER BY document_id", (row["id"],))]
    return {
        "id": row["id"],
        "source_id": row["source_id"],
        "quote": row["quote"],
        "page": row["page"],
        "note": row["note"],
        "created_at": row["created_at"],
        "document_ids": docs,
    }


def _research_doc(conn: sqlite3.Connection, doc_id: int) -> sqlite3.Row:
    row = doc_row(conn, doc_id)
    kind = require_kind(row["kind"])
    if not kind.tools.research_pane or kind.encrypted:
        raise Forbidden(f"{kind.label} has no research tools")
    return row


# ---------------------------------------------------------------- sources


def source_row(conn: sqlite3.Connection, source_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
    if row is None:
        raise NotFound("source not found")
    return row


def list_sources(conn: sqlite3.Connection, q: str = "") -> list[dict]:
    sql = (
        "SELECT s.*, (SELECT count(*) FROM clips c WHERE c.source_id = s.id) AS n FROM sources s"
    )
    params: list[Any] = []
    if q.strip():
        like = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        sql += (
            " WHERE s.title LIKE ? ESCAPE '\\' OR s.author LIKE ? ESCAPE '\\' OR s.notes LIKE ? ESCAPE '\\'"
            " OR EXISTS (SELECT 1 FROM clips c WHERE c.source_id = s.id AND (c.quote LIKE ? ESCAPE '\\' OR c.note LIKE ? ESCAPE '\\'))"
        )
        params = [like] * 5
    sql += " ORDER BY s.updated_at DESC, s.id DESC LIMIT 200"
    return [_source_dict(r, r["n"]) for r in conn.execute(sql, params)]


def get_source(conn: sqlite3.Connection, source_id: int) -> dict:
    row = source_row(conn, source_id)
    out = _source_dict(row)
    out["clips"] = [_clip_dict(conn, c) for c in conn.execute(
        "SELECT * FROM clips WHERE source_id = ? ORDER BY created_at, id", (source_id,))]
    return out


def create_source(conn: sqlite3.Connection, p: Any) -> dict:
    if not isinstance(p, dict):
        raise Invalid("expected a JSON object")
    values = {k: _text(p, k, required=(k == "title")) for k in ("title", "author", "url", "published", "notes")}
    with tx(conn):
        ts = clock.iso()
        cur = conn.execute(
            "INSERT INTO sources (title, author, url, published, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (*values.values(), ts, ts),
        )
        return get_source(conn, cur.lastrowid)


def update_source(conn: sqlite3.Connection, source_id: int, p: Any) -> dict:
    if not isinstance(p, dict):
        raise Invalid("expected a JSON object")
    with tx(conn):
        source_row(conn, source_id)
        sets = {k: _text(p, k, required=(k == "title")) for k in ("title", "author", "url", "published", "notes") if k in p}
        if sets:
            sets["updated_at"] = clock.iso()
            conn.execute(f"UPDATE sources SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", (*sets.values(), source_id))
        return get_source(conn, source_id)


def delete_source(conn: sqlite3.Connection, source_id: int) -> None:
    with tx(conn):
        source_row(conn, source_id)
        conn.execute("DELETE FROM sources WHERE id = ?", (source_id,))


def _find_or_create_source(conn: sqlite3.Connection, s: Any) -> int:
    if isinstance(s, dict) and isinstance(s.get("id"), int):
        return source_row(conn, s["id"])["id"]
    if not isinstance(s, dict):
        raise Invalid("source must be an object")
    values = {k: _text(s, k, required=(k == "title")) for k in ("title", "author", "url", "published")}
    row = None
    if values["url"]:
        row = conn.execute("SELECT id FROM sources WHERE url = ? ORDER BY id LIMIT 1", (values["url"],)).fetchone()
    if row is None:
        row = conn.execute(
            "SELECT id FROM sources WHERE lower(title) = lower(?) AND lower(author) = lower(?) ORDER BY id LIMIT 1",
            (values["title"], values["author"]),
        ).fetchone()
    if row:
        # Fill in anything the existing source was missing.
        existing = source_row(conn, row["id"])
        fills = {k: v for k, v in values.items() if v and not existing[k]}
        if fills:
            conn.execute(f"UPDATE sources SET {', '.join(f'{k} = ?' for k in fills)}, updated_at = ? WHERE id = ?",
                         (*fills.values(), clock.iso(), row["id"]))
        return row["id"]
    ts = clock.iso()
    cur = conn.execute(
        "INSERT INTO sources (title, author, url, published, notes, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, ?)",
        (*values.values(), ts, ts),
    )
    return cur.lastrowid


# ---------------------------------------------------------------- clips


def clip_row(conn: sqlite3.Connection, clip_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_id,)).fetchone()
    if row is None:
        raise NotFound("clip not found")
    return row


def clip(conn: sqlite3.Connection, p: Any) -> dict:
    """The clipper: a quote and its source in one step, attached to documents."""
    if not isinstance(p, dict):
        raise Invalid("expected a JSON object")
    quote = _text(p, "quote", required=True)
    page = _text(p, "page")
    note = _text(p, "note")
    doc_ids = p.get("document_ids") or []
    if not isinstance(doc_ids, list) or not all(isinstance(d, int) for d in doc_ids):
        raise Invalid("document_ids must be a list of ids")
    with tx(conn):
        for d in doc_ids:
            _research_doc(conn, d)
        source_id = _find_or_create_source(conn, p.get("source"))
        ts = clock.iso()
        cur = conn.execute(
            "INSERT INTO clips (source_id, quote, page, note, created_at) VALUES (?, ?, ?, ?, ?)",
            (source_id, quote, page, note, ts),
        )
        for d in doc_ids:
            conn.execute("INSERT OR IGNORE INTO clip_documents (clip_id, document_id, created_at) VALUES (?, ?, ?)",
                         (cur.lastrowid, d, ts))
        conn.execute("UPDATE sources SET updated_at = ? WHERE id = ?", (ts, source_id))
        out = _clip_dict(conn, clip_row(conn, cur.lastrowid))
        out["source"] = _source_dict(source_row(conn, source_id))
        return out


def update_clip(conn: sqlite3.Connection, clip_id: int, p: Any) -> dict:
    if not isinstance(p, dict):
        raise Invalid("expected a JSON object")
    with tx(conn):
        clip_row(conn, clip_id)
        sets = {k: _text(p, k, required=(k == "quote")) for k in ("quote", "page", "note") if k in p}
        if sets:
            conn.execute(f"UPDATE clips SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", (*sets.values(), clip_id))
        return _clip_dict(conn, clip_row(conn, clip_id))


def delete_clip(conn: sqlite3.Connection, clip_id: int) -> None:
    with tx(conn):
        clip_row(conn, clip_id)
        conn.execute("DELETE FROM clips WHERE id = ?", (clip_id,))


def attach(conn: sqlite3.Connection, clip_id: int, doc_id: int, on: bool = True) -> dict:
    with tx(conn):
        clip_row(conn, clip_id)
        _research_doc(conn, doc_id)
        if on:
            conn.execute("INSERT OR IGNORE INTO clip_documents (clip_id, document_id, created_at) VALUES (?, ?, ?)",
                         (clip_id, doc_id, clock.iso()))
        else:
            conn.execute("DELETE FROM clip_documents WHERE clip_id = ? AND document_id = ?", (clip_id, doc_id))
        return _clip_dict(conn, clip_row(conn, clip_id))


def document_clips(conn: sqlite3.Connection, doc_id: int) -> list[dict]:
    _research_doc(conn, doc_id)
    rows = conn.execute(
        "SELECT c.* FROM clips c JOIN clip_documents cd ON cd.clip_id = c.id WHERE cd.document_id = ?"
        " ORDER BY cd.created_at, c.id",
        (doc_id,),
    ).fetchall()
    out = []
    for r in rows:
        d = _clip_dict(conn, r)
        d["source"] = _source_dict(source_row(conn, r["source_id"]))
        out.append(d)
    return out


# ---------------------------------------------------------------- research search


def research_search(conn: sqlite3.Connection, q: str) -> dict:
    """My own documents (searchable kinds only) and my sources and quotes."""
    docs = fts_search(conn, q, all_kinds=True, limit=15) if q.strip() else []
    sources = list_sources(conn, q)[:20] if q.strip() else []
    for s in sources:
        s["clips"] = get_source(conn, s["id"])["clips"]
    return {"documents": docs, "sources": sources}


def preview(conn: sqlite3.Connection, doc_id: int) -> dict:
    row = doc_row(conn, doc_id)
    kind = get_kind(row["kind"])
    if kind is None or kind.encrypted or kind.id not in searchable_kind_ids():
        raise Forbidden("not available in the research pane")
    return {
        "id": row["id"], "kind": row["kind"], "title": row["title"], "content_json": row["content_json"],
        "folder_path": [f["name"] for f in folder_path(conn, row["folder_id"])],
    }


# ---------------------------------------------------------------- reading notes


def _citation(src: sqlite3.Row) -> str:
    bits = [b for b in (src["author"], f"“{src['title']}”", src["published"]) if b]
    return ", ".join(bits)


def reading_notes(conn: sqlite3.Connection, source_id: int, kind_id: str, folder_id: int | None = None) -> dict:
    """A new document for notes on a source, laid out with its quotes."""
    kind = require_kind(kind_id)
    if not kind.tools.research_pane or kind.encrypted:
        raise Forbidden(f"{kind.label} has no research tools")
    with tx(conn):
        src = source_row(conn, source_id)
        clips = conn.execute("SELECT * FROM clips WHERE source_id = ? ORDER BY created_at, id", (source_id,)).fetchall()
        levels = sorted(int(x) for ext in kind.extensions if ext.startswith("heading") for x in (ext.split(":")[1] if ":" in ext else "2,3").split(","))
        has = lambda name: any(e.split(":")[0] == name for e in kind.extensions)

        def heading(text: str) -> dict:
            if levels:
                return {"type": "heading", "attrs": {"level": levels[0]}, "content": [{"type": "text", "text": text}]}
            return {"type": "paragraph", "content": [{"type": "text", "text": text}]}

        source_line: list[dict] = [{"type": "text", "text": _citation(src)}]
        if src["url"] and has("link"):
            source_line += [{"type": "text", "text": " "}, {"type": "text", "text": src["url"], "marks": [{"type": "link", "attrs": {"href": src["url"]}}]}]
        content: list[dict] = [{"type": "paragraph", "content": source_line}, heading("Summary"), {"type": "paragraph"}, heading("Key quotes")]
        for c in clips:
            para: list[dict] = [{"type": "text", "text": c["quote"]}]
            if has("footnote"):
                cite = _citation(src) + (f", p. {c['page']}" if c["page"] else "")
                para.append({"type": "footnote", "attrs": {"text": cite, "sourceId": source_id}})
            elif c["page"]:
                para.append({"type": "text", "text": f" (p. {c['page']})"})
            block = {"type": "paragraph", "content": para}
            content.append({"type": "blockquote", "content": [block]} if has("blockquote") else block)
            if c["note"]:
                content.append({"type": "paragraph", "content": [{"type": "text", "text": c["note"]}]})
        if not clips:
            content.append({"type": "paragraph"})
        content += [heading("My response"), {"type": "paragraph"}]
        doc = create_document(
            conn, kind.id, folder_id=folder_id, title=f"Reading notes: {src['title']}"[:300],
            content_json=json.dumps({"type": "doc", "content": content}),
        )
        ts = clock.iso()
        for c in clips:
            conn.execute("INSERT OR IGNORE INTO clip_documents (clip_id, document_id, created_at) VALUES (?, ?, ?)", (c["id"], doc["id"], ts))
        return doc

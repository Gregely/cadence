"""Draft sets: named snapshots of a whole project (kinds with tools.draft_sets).

A set stores every live document in the project's folder tree at one moment.
Restoring never deletes anything: it first takes an automatic safety set of
the whole project, then puts back the text (and title) of one document or of
every document in the set. Documents written after the set are left as they
are; documents deleted since are brought back.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from . import clock, content
from .errors import Forbidden, Invalid, NotFound
from .library import (
    _place,
    create_document,
    doc_role,
    folder_row,
    require_kind,
    restore_document,
    tx,
    update_document,
)
from .manuscript import project_root, walk

MAX_NAME = 120


def _project(conn: sqlite3.Connection, folder_id: int) -> tuple[Any, sqlite3.Row]:
    root = project_root(conn, folder_id)
    kind = require_kind(root["kind"])
    if not kind.tools.draft_sets or kind.encrypted:
        raise Forbidden(f"{kind.label} has no draft sets")
    return kind, root


def _name(name: Any) -> str:
    if not isinstance(name, str) or not " ".join(name.split()):
        raise Invalid("a draft set needs a name")
    name = " ".join(name.split())
    if len(name) > MAX_NAME:
        raise Invalid("the name is too long")
    return name


def _set_dict(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    n = conn.execute("SELECT count(*) FROM draft_set_items WHERE set_id = ?", (row["id"],)).fetchone()[0]
    words = sum(content.word_count(r[0]) for r in conn.execute("SELECT plain_text FROM draft_set_items WHERE set_id = ?", (row["id"],)))
    return {
        "id": row["id"],
        "folder_id": row["folder_id"],
        "name": row["name"],
        "automatic": bool(row["automatic"]),
        "created_at": row["created_at"],
        "documents": n,
        "words": words,
    }


def _set_row(conn: sqlite3.Connection, set_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM draft_sets WHERE id = ?", (set_id,)).fetchone()
    if row is None:
        raise NotFound("draft set not found")
    folder_row(conn, row["folder_id"], live=False)
    return row


def _take(conn: sqlite3.Connection, root: sqlite3.Row, name: str, automatic: bool) -> int:
    ts = clock.iso()
    cur = conn.execute(
        "INSERT INTO draft_sets (folder_id, name, automatic, created_at) VALUES (?, ?, ?, ?)",
        (root["id"], name, int(automatic), ts),
    )
    set_id = cur.lastrowid
    for what, _, row in walk(conn, root["id"]):
        if what != "doc":
            continue
        conn.execute(
            "INSERT INTO draft_set_items (set_id, document_id, folder_id, sort_order, title, role, content_json, plain_text)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (set_id, row["id"], row["folder_id"], row["sort_order"], row["title"], row["role"], row["content_json"], row["plain_text"]),
        )
    return set_id


def take(conn: sqlite3.Connection, folder_id: int, name: Any) -> dict:
    name = _name(name)
    with tx(conn):
        _, root = _project(conn, folder_id)
        return _set_dict(conn, _set_row(conn, _take(conn, root, name, False)))


def list_sets(conn: sqlite3.Connection, folder_id: int) -> dict:
    _, root = _project(conn, folder_id)
    rows = conn.execute(
        "SELECT * FROM draft_sets WHERE folder_id = ? ORDER BY created_at DESC, id DESC", (root["id"],)
    ).fetchall()
    return {"project": {"id": root["id"], "name": root["name"]}, "sets": [_set_dict(conn, r) for r in rows]}


def get_set(conn: sqlite3.Connection, set_id: int) -> dict:
    row = _set_row(conn, set_id)
    _project(conn, row["folder_id"])
    out = _set_dict(conn, row)
    out["items"] = [
        {"document_id": r["document_id"], "title": r["title"], "role": r["role"], "folder_id": r["folder_id"],
         "words": content.word_count(r["plain_text"])}
        for r in conn.execute("SELECT * FROM draft_set_items WHERE set_id = ? ORDER BY folder_id, sort_order", (set_id,))
    ]
    return out


def get_item(conn: sqlite3.Connection, set_id: int, doc_id: int) -> dict:
    get_set(conn, set_id)
    r = conn.execute("SELECT * FROM draft_set_items WHERE set_id = ? AND document_id = ?", (set_id, doc_id)).fetchone()
    if r is None:
        raise NotFound("that document is not in this draft set")
    return {"set_id": set_id, "document_id": doc_id, "title": r["title"], "role": r["role"], "content_json": r["content_json"]}


def rename(conn: sqlite3.Connection, set_id: int, name: Any) -> dict:
    name = _name(name)
    with tx(conn):
        row = _set_row(conn, set_id)
        _project(conn, row["folder_id"])
        conn.execute("UPDATE draft_sets SET name = ? WHERE id = ?", (name, set_id))
        return _set_dict(conn, _set_row(conn, set_id))


def delete(conn: sqlite3.Connection, set_id: int) -> None:
    with tx(conn):
        row = _set_row(conn, set_id)
        _project(conn, row["folder_id"])
        conn.execute("DELETE FROM draft_sets WHERE id = ?", (set_id,))


def _folder_in_project(conn: sqlite3.Connection, folder_id: int | None, root_id: int) -> bool:
    if folder_id is None:
        return False
    row = conn.execute("SELECT deleted_at FROM folders WHERE id = ?", (folder_id,)).fetchone()
    return row is not None and row["deleted_at"] is None and project_root(conn, folder_id)["id"] == root_id


def restore(conn: sqlite3.Connection, set_id: int, document_id: int | None = None) -> dict:
    """Put back one document, or the whole project, after a safety set."""
    with tx(conn):
        row = _set_row(conn, set_id)
        kind, root = _project(conn, row["folder_id"])
        if document_id is None:
            items = conn.execute("SELECT * FROM draft_set_items WHERE set_id = ?", (set_id,)).fetchall()
        else:
            items = conn.execute(
                "SELECT * FROM draft_set_items WHERE set_id = ? AND document_id = ?", (set_id, document_id)
            ).fetchall()
            if not items:
                raise NotFound("that document is not in this draft set")
        label = "Before restoring a safety set" if row["automatic"] else f"Before restoring “{row['name']}”"
        safety_id = _take(conn, root, label[:MAX_NAME], True)
        restored, recreated, unchanged = [], [], []
        for item in items:
            doc = conn.execute("SELECT * FROM documents WHERE id = ?", (item["document_id"],)).fetchone()
            if doc is not None and doc["kind"] == kind.id:
                was_trashed = doc["deleted_at"] is not None
                if was_trashed:
                    restore_document(conn, doc["id"])
                    doc = conn.execute("SELECT * FROM documents WHERE id = ?", (doc["id"],)).fetchone()
                if doc["content_json"] == item["content_json"] and doc["title"] == item["title"]:
                    (restored if was_trashed else unchanged).append(doc["id"])
                    continue
                update_document(conn, doc["id"], {"content_json": item["content_json"], "title": item["title"]})
                restored.append(doc["id"])
            else:
                # Deleted for good since: bring it back where it was, or at the project's top.
                folder = item["folder_id"] if _folder_in_project(conn, item["folder_id"], root["id"]) else root["id"]
                new = create_document(
                    conn, kind.id, folder_id=folder, title=item["title"], content_json=item["content_json"],
                    role=doc_role(kind, item["role"]),
                )
                _place(conn, "documents", kind.id, folder, new["id"], item["sort_order"])
                recreated.append(new["id"])
        return {
            "safety_set": _set_dict(conn, _set_row(conn, safety_id)),
            "restored": restored,
            "recreated": recreated,
            "unchanged": unchanged,
        }

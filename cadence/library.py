"""Folders, documents, ordering and trash.

All functions take an open connection. Callers wrap mutating calls in a
transaction (see ``tx``) so a failed move or rename never leaves partial
changes behind.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import timedelta
from typing import Any, Iterator

from . import clock, content
from .errors import Conflict, Forbidden, Invalid, NotFound
from .kinds import MAX_FOLDER_DEPTH, Kind, get_kind, searchable_kind_ids

TRASH_DAYS = 30
MAX_NAME = 200
MAX_TITLE = 300


@contextmanager
def tx(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    if conn.in_transaction:
        yield conn
        return
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def require_kind(kind_id: str) -> Kind:
    kind = get_kind(kind_id)
    if kind is None:
        raise Invalid(f"unknown kind {kind_id!r}")
    return kind


# ---------------------------------------------------------------- folders


def folder_row(conn: sqlite3.Connection, folder_id: int, *, live: bool = True) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM folders WHERE id = ?", (folder_id,)).fetchone()
    if row is None or (live and row["deleted_at"] is not None):
        raise NotFound("folder not found")
    return row


def folder_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "parent_id": row["parent_id"],
        "name": row["name"],
        "sort_order": row["sort_order"],
        "deleted_at": row["deleted_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def folder_depth(conn: sqlite3.Connection, folder_id: int | None) -> int:
    """Depth of a folder: 1 for a folder at the kind's root, 0 for the root."""
    depth = 0
    seen: set[int] = set()
    while folder_id is not None:
        if folder_id in seen:  # defensive: corrupted data
            raise Invalid("folder cycle detected")
        seen.add(folder_id)
        depth += 1
        row = conn.execute("SELECT parent_id FROM folders WHERE id = ?", (folder_id,)).fetchone()
        folder_id = row["parent_id"] if row else None
    return depth


def live_descendant_folders(conn: sqlite3.Connection, folder_id: int) -> list[int]:
    rows = conn.execute(
        """
        WITH RECURSIVE sub(id) AS (
            SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NULL
            UNION ALL
            SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
            WHERE f.deleted_at IS NULL
        )
        SELECT id FROM sub
        """,
        (folder_id,),
    ).fetchall()
    return [r[0] for r in rows]


def subtree_height(conn: sqlite3.Connection, folder_id: int) -> int:
    """1 for a folder without live subfolders, 2 with children, and so on."""
    row = conn.execute(
        """
        WITH RECURSIVE sub(id, h) AS (
            SELECT ?, 1
            UNION ALL
            SELECT f.id, sub.h + 1 FROM folders f JOIN sub ON f.parent_id = sub.id
            WHERE f.deleted_at IS NULL AND sub.h < 64
        )
        SELECT max(h) FROM sub
        """,
        (folder_id,),
    ).fetchone()
    return row[0] or 1


def folder_path(conn: sqlite3.Connection, folder_id: int | None) -> list[dict]:
    path: list[dict] = []
    seen: set[int] = set()
    while folder_id is not None and folder_id not in seen:
        seen.add(folder_id)
        row = conn.execute("SELECT id, name, parent_id FROM folders WHERE id = ?", (folder_id,)).fetchone()
        if row is None:
            break
        path.append({"id": row["id"], "name": row["name"]})
        folder_id = row["parent_id"]
    return list(reversed(path))


def _clean_name(name: Any, limit: int, what: str, allow_empty: bool = False) -> str:
    if not isinstance(name, str):
        raise Invalid(f"{what} must be text")
    name = " ".join(name.split())
    if not name and not allow_empty:
        raise Invalid(f"{what} cannot be empty")
    if len(name) > limit:
        raise Invalid(f"{what} is too long")
    return name


def _check_parent(conn: sqlite3.Connection, kind: Kind, parent_id: int | None) -> None:
    if parent_id is None:
        return
    parent = folder_row(conn, parent_id)
    if parent["kind"] != kind.id:
        raise Forbidden("a folder cannot hold items of another kind")


def create_folder(
    conn: sqlite3.Connection, kind_id: str, name: str, parent_id: int | None = None, index: int | None = None
) -> dict:
    kind = require_kind(kind_id)
    if not kind.folders_enabled:
        raise Forbidden(f"{kind.label} does not use folders")
    name = _clean_name(name, MAX_NAME, "folder name")
    with tx(conn):
        _check_parent(conn, kind, parent_id)
        if folder_depth(conn, parent_id) + 1 > MAX_FOLDER_DEPTH:
            raise Invalid(f"folders can be nested at most {MAX_FOLDER_DEPTH} deep")
        ts = clock.iso()
        cur = conn.execute(
            "INSERT INTO folders (kind, parent_id, name, sort_order, created_at, updated_at)"
            " VALUES (?, ?, ?, 0, ?, ?)",
            (kind.id, parent_id, name, ts, ts),
        )
        folder_id = cur.lastrowid
        _place(conn, "folders", kind.id, parent_id, folder_id, index)
        return folder_dict(folder_row(conn, folder_id))


def rename_folder(conn: sqlite3.Connection, folder_id: int, name: str) -> dict:
    name = _clean_name(name, MAX_NAME, "folder name")
    with tx(conn):
        folder_row(conn, folder_id)
        conn.execute("UPDATE folders SET name = ?, updated_at = ? WHERE id = ?", (name, clock.iso(), folder_id))
        return folder_dict(folder_row(conn, folder_id))


def move_folder(
    conn: sqlite3.Connection,
    folder_id: int,
    parent_id: int | None,
    index: int | None = None,
    kind_id: str | None = None,
) -> dict:
    with tx(conn):
        folder = folder_row(conn, folder_id)
        kind = require_kind(folder["kind"])
        if kind_id is not None and kind_id != kind.id:
            raise Forbidden("folders cannot move to another kind")
        if parent_id is not None:
            parent = folder_row(conn, parent_id)
            if parent["kind"] != kind.id:
                raise Forbidden("folders cannot move to another kind")
            if parent_id == folder_id or parent_id in live_descendant_folders(conn, folder_id):
                raise Invalid("a folder cannot be moved inside itself")
            # Also walk up from the new parent in case of trashed links.
            ancestor = parent_id
            seen: set[int] = set()
            while ancestor is not None and ancestor not in seen:
                if ancestor == folder_id:
                    raise Invalid("a folder cannot be moved inside itself")
                seen.add(ancestor)
                r = conn.execute("SELECT parent_id FROM folders WHERE id = ?", (ancestor,)).fetchone()
                ancestor = r["parent_id"] if r else None
        if folder_depth(conn, parent_id) + subtree_height(conn, folder_id) > MAX_FOLDER_DEPTH:
            raise Invalid(f"folders can be nested at most {MAX_FOLDER_DEPTH} deep")
        old_parent = folder["parent_id"]
        conn.execute(
            "UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?", (parent_id, clock.iso(), folder_id)
        )
        _place(conn, "folders", kind.id, parent_id, folder_id, index)
        if old_parent != parent_id:
            _renumber(conn, "folders", kind.id, old_parent)
        return folder_dict(folder_row(conn, folder_id))


def delete_folder(conn: sqlite3.Connection, folder_id: int) -> dict:
    """Soft-delete a folder with everything in it, as one trash batch."""
    with tx(conn):
        folder = folder_row(conn, folder_id)
        ts = clock.iso()
        ids = [folder_id] + live_descendant_folders(conn, folder_id)
        marks = ",".join("?" * len(ids))
        conn.execute(f"UPDATE folders SET deleted_at = ? WHERE id IN ({marks})", (ts, *ids))
        doc_ids = [
            r[0]
            for r in conn.execute(
                f"SELECT id FROM documents WHERE deleted_at IS NULL AND folder_id IN ({marks})", ids
            )
        ]
        for doc_id in doc_ids:
            conn.execute("UPDATE documents SET deleted_at = ? WHERE id = ?", (ts, doc_id))
            fts_remove(conn, doc_id)
        _renumber(conn, "folders", folder["kind"], folder["parent_id"])
        return {"folders": len(ids), "documents": len(doc_ids), "deleted_at": ts}


# ---------------------------------------------------------------- ordering


def _sibling_ids(conn: sqlite3.Connection, table: str, kind_id: str, parent: int | None, exclude: int | None) -> list[int]:
    col = "parent_id" if table == "folders" else "folder_id"
    rows = conn.execute(
        f"SELECT id FROM {table} WHERE kind = ? AND {col} IS ? AND deleted_at IS NULL AND id IS NOT ?"
        " ORDER BY sort_order, id",
        (kind_id, parent, exclude),
    ).fetchall()
    return [r[0] for r in rows]


def _place(
    conn: sqlite3.Connection, table: str, kind_id: str, parent: int | None, item_id: int, index: int | None
) -> None:
    """Put item at `index` among its siblings (end if None) and renumber 0..n."""
    ids = _sibling_ids(conn, table, kind_id, parent, item_id)
    if index is None or index > len(ids):
        index = len(ids)
    if index < 0:
        index = 0
    ids.insert(index, item_id)
    for pos, i in enumerate(ids):
        conn.execute(f"UPDATE {table} SET sort_order = ? WHERE id = ?", (pos, i))


def _renumber(conn: sqlite3.Connection, table: str, kind_id: str, parent: int | None) -> None:
    for pos, i in enumerate(_sibling_ids(conn, table, kind_id, parent, None)):
        conn.execute(f"UPDATE {table} SET sort_order = ? WHERE id = ?", (pos, i))


# ---------------------------------------------------------------- documents


DOC_LIST_COLUMNS = (
    "id, kind, folder_id, sort_order, title, status, meta_json, created_at, updated_at,"
    " last_opened_at, deleted_at, plain_text"
)


def doc_row(conn: sqlite3.Connection, doc_id: int, *, live: bool = True) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if row is None or (live and row["deleted_at"] is not None):
        raise NotFound("document not found")
    return row


def doc_summary(row: sqlite3.Row) -> dict:
    kind = get_kind(row["kind"])
    encrypted = kind.encrypted if kind else True
    keys = row.keys()
    text = row["plain_text"] if "plain_text" in keys else ""
    meta = json.loads(row["meta_json"] or "{}")
    out = {
        "id": row["id"],
        "kind": row["kind"],
        "folder_id": row["folder_id"],
        "sort_order": row["sort_order"],
        "title": row["title"],
        "status": row["status"],
        "word_target": meta.get("word_target"),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_opened_at": row["last_opened_at"],
        "deleted_at": row["deleted_at"],
    }
    if not encrypted:
        excerpt = " ".join((text or "")[:240].split())
        out["excerpt"] = excerpt[:160]
        out["words"] = content.word_count(text or "")
    return out


def doc_full(row: sqlite3.Row) -> dict:
    out = doc_summary(row)
    out["content_json"] = row["content_json"]
    out["meta"] = json.loads(row["meta_json"] or "{}")
    kind = get_kind(row["kind"])
    if kind and not kind.encrypted:
        out["plain_text"] = row["plain_text"]
    return out


def generated_title(kind: Kind, when: str | None = None) -> str:
    stamp = (when or clock.iso())[:10]
    return f"{kind.item_label} {stamp}"


ENCRYPTED_META_KEYS = {"cursor"}


def _prepare_content(
    kind: Kind, content_json: Any, plain_text: Any
) -> tuple[str, str]:
    """Return (content_json, plain_text) to store, enforcing the kind's rules."""
    if kind.encrypted:
        if plain_text not in (None, ""):
            raise Invalid(f"{kind.label} is encrypted: plain_text is not accepted")
        if content_json is None:
            raise Invalid(f"{kind.label} is encrypted: content must be an encrypted envelope")
        return content.validate_envelope(content_json), ""
    if content_json is None:
        if plain_text is not None and not isinstance(plain_text, str):
            raise Invalid("plain_text must be text")
        doc = content.doc_from_text(plain_text) if plain_text else content.empty_doc()
    else:
        doc = content.parse_json(content_json)
    content.validate_doc(doc, kind)
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":")), content.plain_text(doc)


def _prepare_meta(kind: Kind, meta: Any, existing: dict | None = None) -> str:
    merged = dict(existing or {})
    if meta is None:
        return json.dumps(merged)
    if not isinstance(meta, dict):
        raise Invalid("meta must be an object")
    if kind.encrypted and set(meta) - ENCRYPTED_META_KEYS:
        raise Invalid(f"{kind.label} is encrypted: only cursor may be stored in meta")
    for key, value in meta.items():
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = value
    if "word_target" in merged:
        wt = merged["word_target"]
        if not isinstance(wt, int) or wt < 0 or wt > 10_000_000:
            raise Invalid("word_target must be a positive whole number")
        if not kind.tools.word_target:
            raise Invalid(f"{kind.label} has no word target")
    raw = json.dumps(merged, ensure_ascii=False)
    if len(raw) > 64 * 1024:
        raise Invalid("meta is too large")
    return raw


def _check_status(kind: Kind, status: Any) -> str | None:
    if status in (None, ""):
        return None
    if not kind.tools.status or status not in kind.statuses:
        raise Invalid(f"status {status!r} is not valid for {kind.label}")
    return status


def _check_title(kind: Kind, title: Any) -> str | None:
    if title is None:
        return None
    if kind.title_mode == "generated":
        raise Invalid(f"{kind.label} titles are generated and cannot be set")
    return _clean_name(title, MAX_TITLE, "title", allow_empty=True)


def create_document(
    conn: sqlite3.Connection,
    kind_id: str,
    *,
    folder_id: int | None = None,
    title: str | None = None,
    content_json: Any = None,
    plain_text: Any = None,
    status: str | None = None,
    meta: dict | None = None,
    index: int | None = None,
) -> dict:
    kind = require_kind(kind_id)
    if folder_id is not None and not kind.folders_enabled:
        raise Forbidden(f"{kind.label} does not use folders")
    stored_content, stored_text = _prepare_content(kind, content_json, plain_text)
    title = _check_title(kind, title)
    status = _check_status(kind, status)
    meta_raw = _prepare_meta(kind, meta)
    with tx(conn):
        _check_parent(conn, kind, folder_id)
        ts = clock.iso()
        if kind.title_mode == "generated":
            title = generated_title(kind, ts)
        cur = conn.execute(
            "INSERT INTO documents (kind, folder_id, sort_order, title, content_json, plain_text,"
            " status, meta_json, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)",
            (kind.id, folder_id, title or "", stored_content, stored_text, status, meta_raw, ts, ts),
        )
        doc_id = cur.lastrowid
        _place(conn, "documents", kind.id, folder_id, doc_id, index)
        fts_sync(conn, doc_id)
        return doc_full(doc_row(conn, doc_id))


UPDATABLE = {"title", "content_json", "plain_text", "status", "meta", "if_updated_at"}


def update_document(conn: sqlite3.Connection, doc_id: int, changes: dict) -> dict:
    if "kind" in changes:
        raise Forbidden("documents cannot change kind")
    if "folder_id" in changes:
        raise Invalid("use the move endpoint to change a document's folder")
    unknown = set(changes) - UPDATABLE
    if unknown:
        raise Invalid(f"unknown fields: {', '.join(sorted(unknown))}")
    with tx(conn):
        row = doc_row(conn, doc_id)
        kind = require_kind(row["kind"])
        expected = changes.get("if_updated_at")
        if expected is not None and expected != row["updated_at"]:
            raise Conflict("document was changed elsewhere")
        sets: dict[str, Any] = {}
        if "content_json" in changes or "plain_text" in changes:
            if kind.encrypted and changes.get("plain_text") not in (None, ""):
                raise Invalid(f"{kind.label} is encrypted: plain_text is not accepted")
            if "content_json" in changes or not kind.encrypted:
                sets["content_json"], sets["plain_text"] = _prepare_content(
                    kind, changes.get("content_json"), changes.get("plain_text")
                )
        if "title" in changes:
            sets["title"] = _check_title(kind, changes["title"]) or ""
        if "status" in changes:
            sets["status"] = _check_status(kind, changes["status"])
        if "meta" in changes:
            sets["meta_json"] = _prepare_meta(kind, changes["meta"], json.loads(row["meta_json"] or "{}"))
        if sets:
            # Cursor-only changes do not count as edits.
            meta_only_cursor = set(sets) == {"meta_json"} and set(changes.get("meta") or {}) <= {"cursor"}
            if not meta_only_cursor:
                sets["updated_at"] = clock.iso()
                if sets["updated_at"] <= row["updated_at"]:
                    # Keep updated_at strictly increasing for conflict checks.
                    sets["updated_at"] = _bump(row["updated_at"])
            cols = ", ".join(f"{k} = ?" for k in sets)
            conn.execute(f"UPDATE documents SET {cols} WHERE id = ?", (*sets.values(), doc_id))
            fts_sync(conn, doc_id)
        return doc_full(doc_row(conn, doc_id))


def _bump(ts: str) -> str:
    from datetime import datetime

    dt = datetime.fromisoformat(ts.replace("Z", "+00:00")) + timedelta(milliseconds=1)
    return clock.iso(dt)


def open_document(conn: sqlite3.Connection, doc_id: int) -> dict:
    with tx(conn):
        row = doc_row(conn, doc_id)
        conn.execute("UPDATE documents SET last_opened_at = ? WHERE id = ?", (clock.iso(), doc_id))
        out = doc_full(doc_row(conn, doc_id))
        note = conn.execute(
            "SELECT reentry_note, ended_at FROM sessions WHERE document_id = ? AND ended_at IS NOT NULL"
            " AND reentry_note IS NOT NULL AND reentry_note != '' ORDER BY ended_at DESC, id DESC LIMIT 1",
            (doc_id,),
        ).fetchone()
        out["reentry_note"] = note["reentry_note"] if note else None
        out["reentry_note_at"] = note["ended_at"] if note else None
        out["folder_path"] = folder_path(conn, row["folder_id"])
        return out


def move_document(
    conn: sqlite3.Connection,
    doc_id: int,
    folder_id: int | None,
    index: int | None = None,
    kind_id: str | None = None,
) -> dict:
    with tx(conn):
        row = doc_row(conn, doc_id)
        kind = require_kind(row["kind"])
        if kind_id is not None and kind_id != kind.id:
            raise Forbidden("documents cannot move to another kind")
        if folder_id is not None and not kind.folders_enabled:
            raise Forbidden(f"{kind.label} does not use folders")
        _check_parent(conn, kind, folder_id)
        old = row["folder_id"]
        conn.execute("UPDATE documents SET folder_id = ? WHERE id = ?", (folder_id, doc_id))
        _place(conn, "documents", kind.id, folder_id, doc_id, index)
        if old != folder_id:
            _renumber(conn, "documents", kind.id, old)
        return doc_summary(doc_row(conn, doc_id))


def delete_document(conn: sqlite3.Connection, doc_id: int) -> dict:
    with tx(conn):
        row = doc_row(conn, doc_id)
        ts = clock.iso()
        conn.execute("UPDATE documents SET deleted_at = ? WHERE id = ?", (ts, doc_id))
        fts_remove(conn, doc_id)
        _renumber(conn, "documents", row["kind"], row["folder_id"])
        return {"deleted_at": ts}


def tree(conn: sqlite3.Connection, kind_id: str) -> dict:
    kind = require_kind(kind_id)
    folders = [
        folder_dict(r)
        for r in conn.execute(
            "SELECT * FROM folders WHERE kind = ? AND deleted_at IS NULL ORDER BY parent_id, sort_order, id",
            (kind.id,),
        )
    ]
    docs = [
        doc_summary(r)
        for r in conn.execute(
            f"SELECT {DOC_LIST_COLUMNS} FROM documents WHERE kind = ? AND deleted_at IS NULL"
            " ORDER BY folder_id, sort_order, id",
            (kind.id,),
        )
    ]
    return {"kind": kind.id, "folders": folders, "documents": docs}


def last_opened(conn: sqlite3.Connection) -> dict | None:
    row = conn.execute(
        "SELECT id, kind FROM documents WHERE deleted_at IS NULL AND last_opened_at IS NOT NULL"
        " ORDER BY last_opened_at DESC LIMIT 1"
    ).fetchone()
    if row is None or get_kind(row["kind"]) is None:
        return None
    return {"id": row["id"], "kind": row["kind"]}


def last_opened_in_kind(conn: sqlite3.Connection, kind_id: str) -> int | None:
    row = conn.execute(
        "SELECT id FROM documents WHERE kind = ? AND deleted_at IS NULL"
        " ORDER BY last_opened_at IS NULL, last_opened_at DESC, updated_at DESC LIMIT 1",
        (kind_id,),
    ).fetchone()
    return row["id"] if row else None


# ---------------------------------------------------------------- search index


def fts_remove(conn: sqlite3.Connection, doc_id: int) -> None:
    conn.execute("DELETE FROM documents_fts WHERE rowid = ?", (doc_id,))


def fts_sync(conn: sqlite3.Connection, doc_id: int) -> None:
    fts_remove(conn, doc_id)
    row = conn.execute(
        "SELECT kind, title, plain_text, deleted_at FROM documents WHERE id = ?", (doc_id,)
    ).fetchone()
    if row is None or row["deleted_at"] is not None:
        return
    kind = get_kind(row["kind"])
    if kind is None or not kind.searchable or kind.encrypted:
        return
    conn.execute(
        "INSERT INTO documents_fts (rowid, title, plain_text) VALUES (?, ?, ?)",
        (doc_id, row["title"], row["plain_text"]),
    )


def fts_rebuild(conn: sqlite3.Connection) -> None:
    """Rebuild the index from the registry's current searchable kinds."""
    ids = [k for k in searchable_kind_ids() if not require_kind(k).encrypted]
    with tx(conn):
        conn.execute("DELETE FROM documents_fts")
        if ids:
            marks = ",".join("?" * len(ids))
            conn.execute(
                "INSERT INTO documents_fts (rowid, title, plain_text)"
                f" SELECT id, title, plain_text FROM documents WHERE deleted_at IS NULL AND kind IN ({marks})",
                ids,
            )


# ---------------------------------------------------------------- trash


def trash(conn: sqlite3.Connection, kind_id: str | None = None) -> dict:
    """Top-level trashed items: those not deleted as part of a parent's batch."""
    params: list[Any] = []
    kind_sql = ""
    if kind_id:
        require_kind(kind_id)
        kind_sql = " AND f.kind = ?"
        params.append(kind_id)
    folders = conn.execute(
        "SELECT f.* FROM folders f LEFT JOIN folders p ON p.id = f.parent_id"
        " WHERE f.deleted_at IS NOT NULL AND (p.id IS NULL OR p.deleted_at IS NOT f.deleted_at)"
        f"{kind_sql} ORDER BY f.deleted_at DESC",
        params,
    ).fetchall()
    doc_kind_sql = kind_sql.replace("f.kind", "d.kind")
    docs = conn.execute(
        f"SELECT d.id, d.kind, d.folder_id, d.sort_order, d.title, d.status, d.meta_json, d.created_at,"
        " d.updated_at, d.last_opened_at, d.deleted_at, d.plain_text"
        " FROM documents d LEFT JOIN folders p ON p.id = d.folder_id"
        " WHERE d.deleted_at IS NOT NULL AND (p.id IS NULL OR p.deleted_at IS NOT d.deleted_at)"
        f"{doc_kind_sql} ORDER BY d.deleted_at DESC",
        params,
    ).fetchall()
    out_folders = []
    for f in folders:
        d = folder_dict(f)
        d["contains"] = _batch_counts(conn, f["id"], f["deleted_at"])
        out_folders.append(d)
    return {
        "folders": out_folders,
        "documents": [doc_summary(d) for d in docs],
        "purge_after_days": TRASH_DAYS,
    }


def _batch_folders(conn: sqlite3.Connection, folder_id: int, deleted_at: str) -> list[int]:
    rows = conn.execute(
        """
        WITH RECURSIVE sub(id) AS (
            SELECT ?
            UNION ALL
            SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id WHERE f.deleted_at = ?
        )
        SELECT id FROM sub
        """,
        (folder_id, deleted_at),
    ).fetchall()
    return [r[0] for r in rows]


def _batch_counts(conn: sqlite3.Connection, folder_id: int, deleted_at: str) -> dict:
    ids = _batch_folders(conn, folder_id, deleted_at)
    marks = ",".join("?" * len(ids))
    docs = conn.execute(
        f"SELECT count(*) FROM documents WHERE deleted_at = ? AND folder_id IN ({marks})", (deleted_at, *ids)
    ).fetchone()[0]
    return {"folders": len(ids) - 1, "documents": docs}


def _folder_is_live(conn: sqlite3.Connection, folder_id: int | None) -> bool:
    if folder_id is None:
        return False
    row = conn.execute("SELECT deleted_at FROM folders WHERE id = ?", (folder_id,)).fetchone()
    return row is not None and row["deleted_at"] is None


def restore_document(conn: sqlite3.Connection, doc_id: int) -> dict:
    with tx(conn):
        row = doc_row(conn, doc_id, live=False)
        if row["deleted_at"] is None:
            return doc_summary(row)
        folder_id = row["folder_id"] if _folder_is_live(conn, row["folder_id"]) else None
        conn.execute("UPDATE documents SET deleted_at = NULL, folder_id = ? WHERE id = ?", (folder_id, doc_id))
        _place(conn, "documents", row["kind"], folder_id, doc_id, None)
        fts_sync(conn, doc_id)
        return doc_summary(doc_row(conn, doc_id))


def restore_folder(conn: sqlite3.Connection, folder_id: int) -> dict:
    with tx(conn):
        row = folder_row(conn, folder_id, live=False)
        if row["deleted_at"] is None:
            return folder_dict(row)
        batch = _batch_folders(conn, folder_id, row["deleted_at"])
        parent = row["parent_id"] if _folder_is_live(conn, row["parent_id"]) else None
        height = _batch_height(conn, folder_id, row["deleted_at"])
        if folder_depth(conn, parent) + height > MAX_FOLDER_DEPTH:
            parent = None
        marks = ",".join("?" * len(batch))
        conn.execute(
            f"UPDATE documents SET deleted_at = NULL WHERE deleted_at = ? AND folder_id IN ({marks})",
            (row["deleted_at"], *batch),
        )
        restored_docs = [
            r[0]
            for r in conn.execute(
                f"SELECT id FROM documents WHERE deleted_at IS NULL AND folder_id IN ({marks})", batch
            )
        ]
        conn.execute(f"UPDATE folders SET deleted_at = NULL WHERE id IN ({marks})", batch)
        conn.execute("UPDATE folders SET parent_id = ? WHERE id = ?", (parent, folder_id))
        _place(conn, "folders", row["kind"], parent, folder_id, None)
        for doc_id in restored_docs:
            fts_sync(conn, doc_id)
        return folder_dict(folder_row(conn, folder_id))


def _batch_height(conn: sqlite3.Connection, folder_id: int, deleted_at: str) -> int:
    row = conn.execute(
        """
        WITH RECURSIVE sub(id, h) AS (
            SELECT ?, 1
            UNION ALL
            SELECT f.id, sub.h + 1 FROM folders f JOIN sub ON f.parent_id = sub.id
            WHERE f.deleted_at = ? AND sub.h < 64
        )
        SELECT max(h) FROM sub
        """,
        (folder_id, deleted_at),
    ).fetchone()
    return row[0] or 1


def purge_document(conn: sqlite3.Connection, doc_id: int) -> None:
    with tx(conn):
        row = doc_row(conn, doc_id, live=False)
        if row["deleted_at"] is None:
            raise Invalid("only trashed documents can be deleted permanently")
        fts_remove(conn, doc_id)
        conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))


def purge_folder(conn: sqlite3.Connection, folder_id: int) -> None:
    with tx(conn):
        row = folder_row(conn, folder_id, live=False)
        if row["deleted_at"] is None:
            raise Invalid("only trashed folders can be deleted permanently")
        batch = _batch_folders(conn, folder_id, row["deleted_at"])
        marks = ",".join("?" * len(batch))
        for (doc_id,) in conn.execute(
            f"SELECT id FROM documents WHERE deleted_at = ? AND folder_id IN ({marks})",
            (row["deleted_at"], *batch),
        ).fetchall():
            fts_remove(conn, doc_id)
            conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        conn.execute(f"DELETE FROM folders WHERE id IN ({marks})", batch)


def purge_expired(conn: sqlite3.Connection, days: int = TRASH_DAYS) -> dict:
    cutoff = clock.iso(clock.now() - timedelta(days=days))
    with tx(conn):
        doc_ids = [
            r[0]
            for r in conn.execute(
                "SELECT id FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,)
            )
        ]
        for doc_id in doc_ids:
            fts_remove(conn, doc_id)
        conn.execute("DELETE FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,))
        n_folders = conn.execute(
            "DELETE FROM folders WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,)
        ).rowcount
    return {"documents": len(doc_ids), "folders": n_folders}

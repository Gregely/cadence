"""Snapshots, the capture inbox and writing sessions."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from . import clock, content
from .errors import Forbidden, Invalid, NotFound
from .kinds import get_kind
from .library import create_document, doc_full, doc_row, require_kind, tx, update_document

MAX_LABEL = 120
MAX_CAPTURE = 4000
MAX_NOTE = 280

# ---------------------------------------------------------------- snapshots


def _snapshot_dict(row: sqlite3.Row, with_content: bool = False) -> dict:
    out = {
        "id": row["id"],
        "document_id": row["document_id"],
        "label": row["label"],
        "created_at": row["created_at"],
    }
    if with_content:
        out["content_json"] = row["content_json"]
    return out


def _label(label: Any, default: str) -> str:
    if label is None or (isinstance(label, str) and not label.strip()):
        return default
    if not isinstance(label, str):
        raise Invalid("label must be text")
    label = " ".join(label.split())
    if len(label) > MAX_LABEL:
        raise Invalid("label is too long")
    return label


def create_snapshot(
    conn: sqlite3.Connection, doc_id: int, label: str | None = None, content_json: Any = None
) -> dict:
    """Snapshot the stored content, or the given content (e.g. a conflict copy)."""
    with tx(conn):
        row = doc_row(conn, doc_id)
        kind = require_kind(row["kind"])
        if kind.tools.snapshots == "off":
            raise Forbidden(f"{kind.label} has no snapshots")
        if content_json is None:
            stored = row["content_json"]
        elif kind.encrypted:
            stored = content.validate_envelope(content_json)
        else:
            doc = content.validate_doc(content.parse_json(content_json), kind)
            stored = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
        ts = clock.iso()
        generic = "Snapshot " + ts[:16].replace("T", " ")
        # Labels are stored as plain text, so encrypted kinds only get dated ones.
        name = generic if kind.encrypted else _label(label, generic)
        cur = conn.execute(
            "INSERT INTO snapshots (document_id, label, content_json, created_at) VALUES (?, ?, ?, ?)",
            (doc_id, name, stored, ts),
        )
        return _snapshot_dict(conn.execute("SELECT * FROM snapshots WHERE id = ?", (cur.lastrowid,)).fetchone())


def list_snapshots(conn: sqlite3.Connection, doc_id: int) -> list[dict]:
    doc_row(conn, doc_id)
    rows = conn.execute(
        "SELECT * FROM snapshots WHERE document_id = ? ORDER BY created_at DESC, id DESC", (doc_id,)
    ).fetchall()
    return [_snapshot_dict(r) for r in rows]


def get_snapshot(conn: sqlite3.Connection, snap_id: int) -> dict:
    row = conn.execute("SELECT * FROM snapshots WHERE id = ?", (snap_id,)).fetchone()
    if row is None:
        raise NotFound("snapshot not found")
    doc_row(conn, row["document_id"])
    return _snapshot_dict(row, with_content=True)


def rename_snapshot(conn: sqlite3.Connection, snap_id: int, label: str) -> dict:
    with tx(conn):
        snap = get_snapshot(conn, snap_id)
        kind = require_kind(doc_row(conn, snap["document_id"])["kind"])
        if kind.encrypted:
            raise Forbidden(f"{kind.label} snapshots keep dated names (a name would be stored unencrypted)")
        conn.execute("UPDATE snapshots SET label = ? WHERE id = ?", (_label(label, "Snapshot"), snap_id))
        return _snapshot_dict(conn.execute("SELECT * FROM snapshots WHERE id = ?", (snap_id,)).fetchone())


def delete_snapshot(conn: sqlite3.Connection, snap_id: int) -> None:
    with tx(conn):
        get_snapshot(conn, snap_id)
        conn.execute("DELETE FROM snapshots WHERE id = ?", (snap_id,))


def restore_snapshot(conn: sqlite3.Connection, snap_id: int) -> dict:
    """Replace the document's content with a snapshot, keeping the current
    content as a new snapshot first so nothing is lost."""
    with tx(conn):
        snap = get_snapshot(conn, snap_id)
        doc_id = snap["document_id"]
        row = doc_row(conn, doc_id)
        ts = clock.iso()
        conn.execute(
            "INSERT INTO snapshots (document_id, label, content_json, created_at) VALUES (?, ?, ?, ?)",
            (doc_id, f"Before restoring “{snap['label']}”"[:MAX_LABEL], row["content_json"], ts),
        )
        return update_document(conn, doc_id, {"content_json": snap["content_json"]})


# ---------------------------------------------------------------- inbox


def _inbox_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "text": row["text"],
        "from_kind": row["from_kind"],
        "created_at": row["created_at"],
        "handled_at": row["handled_at"],
    }


def capture(conn: sqlite3.Connection, text: Any, from_kind: str | None) -> dict:
    if not isinstance(text, str) or not text.strip():
        raise Invalid("nothing to capture")
    text = text.strip()
    if len(text) > MAX_CAPTURE:
        raise Invalid("capture is too long")
    if from_kind is not None:
        kind = require_kind(from_kind)
        if not kind.capture_allowed:
            raise Forbidden(f"capture is off in {kind.label}: the inbox is not encrypted")
    with tx(conn):
        cur = conn.execute(
            "INSERT INTO inbox (text, from_kind, created_at) VALUES (?, ?, ?)", (text, from_kind, clock.iso())
        )
        return _inbox_dict(conn.execute("SELECT * FROM inbox WHERE id = ?", (cur.lastrowid,)).fetchone())


def _reviewable_kinds() -> set[str | None]:
    from .kinds import all_kinds

    return {None} | {k.id for k in all_kinds() if k.capture_allowed}


def list_inbox(conn: sqlite3.Connection, include_handled: bool = False) -> list[dict]:
    sql = "SELECT * FROM inbox"
    if not include_handled:
        sql += " WHERE handled_at IS NULL"
    sql += " ORDER BY created_at DESC, id DESC"
    allowed = _reviewable_kinds()
    # Defence in depth: items tagged with an encrypted kind (should never
    # exist) are never shown in review.
    return [_inbox_dict(r) for r in conn.execute(sql) if r["from_kind"] in allowed]


def _inbox_row(conn: sqlite3.Connection, item_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM inbox WHERE id = ?", (item_id,)).fetchone()
    if row is None or row["from_kind"] not in _reviewable_kinds():
        raise NotFound("inbox item not found")
    return row


def set_handled(conn: sqlite3.Connection, item_id: int, handled: bool) -> dict:
    with tx(conn):
        _inbox_row(conn, item_id)
        conn.execute("UPDATE inbox SET handled_at = ? WHERE id = ?", (clock.iso() if handled else None, item_id))
        return _inbox_dict(_inbox_row(conn, item_id))


def edit_inbox(conn: sqlite3.Connection, item_id: int, text: Any) -> dict:
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_CAPTURE:
        raise Invalid("inbox text must be 1 to 4000 characters")
    with tx(conn):
        _inbox_row(conn, item_id)
        conn.execute("UPDATE inbox SET text = ? WHERE id = ?", (text.strip(), item_id))
        return _inbox_dict(_inbox_row(conn, item_id))


def delete_inbox(conn: sqlite3.Connection, item_id: int) -> None:
    with tx(conn):
        _inbox_row(conn, item_id)
        conn.execute("DELETE FROM inbox WHERE id = ?", (item_id,))


def inbox_to_document(
    conn: sqlite3.Connection, item_id: int, kind_id: str, folder_id: int | None = None, document_id: int | None = None
) -> dict:
    """Turn a captured line into a new document, or append it to one."""
    with tx(conn):
        item = _inbox_row(conn, item_id)
        kind = require_kind(kind_id)
        if kind.encrypted:
            raise Forbidden(f"{kind.label} is encrypted; copy the text in by hand")
        if document_id is not None:
            row = doc_row(conn, document_id)
            if row["kind"] != kind.id:
                raise Forbidden("document is in another kind")
            doc = json.loads(row["content_json"])
            doc.setdefault("content", []).extend(content.doc_from_text(item["text"])["content"])
            result = update_document(conn, document_id, {"content_json": json.dumps(doc)})
        else:
            first_line = item["text"].split("\n", 1)[0][:80]
            title = "" if kind.title_mode == "optional" else first_line
            result = create_document(conn, kind.id, folder_id=folder_id, title=title, plain_text=item["text"])
        conn.execute("UPDATE inbox SET handled_at = ? WHERE id = ?", (clock.iso(), item_id))
        return result


# ---------------------------------------------------------------- sessions


def _session_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "document_id": row["document_id"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "words_start": row["words_start"],
        "words_end": row["words_end"],
        "reentry_note": row["reentry_note"],
        "checkpoints": json.loads(row["checkpoints_json"] or "[]"),
    }


def _words(value: Any) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise Invalid("word counts must be whole numbers")
    return value


def _session_kind_check(conn: sqlite3.Connection, doc_id: int) -> None:
    row = doc_row(conn, doc_id)
    kind = get_kind(row["kind"])
    if kind is None or not kind.sessions_allowed:
        raise Forbidden("sessions are not kept for this kind")


def start_session(conn: sqlite3.Connection, doc_id: int, words_start: Any = None) -> dict:
    with tx(conn):
        _session_kind_check(conn, doc_id)
        cur = conn.execute(
            "INSERT INTO sessions (document_id, started_at, words_start) VALUES (?, ?, ?)",
            (doc_id, clock.iso(), _words(words_start)),
        )
        return _session_dict(conn.execute("SELECT * FROM sessions WHERE id = ?", (cur.lastrowid,)).fetchone())


def _session_row(conn: sqlite3.Connection, session_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise NotFound("session not found")
    return row


CHECKPOINTS = {"flowing", "fighting"}


def add_checkpoint(conn: sqlite3.Connection, session_id: int, feeling: Any) -> dict:
    if feeling not in CHECKPOINTS:
        raise Invalid("checkpoint must be 'flowing' or 'fighting'")
    with tx(conn):
        row = _session_row(conn, session_id)
        if row["ended_at"]:
            raise Invalid("session has ended")
        points = json.loads(row["checkpoints_json"] or "[]")
        points.append({"at": clock.iso(), "feeling": feeling})
        conn.execute("UPDATE sessions SET checkpoints_json = ? WHERE id = ?", (json.dumps(points[-200:]), session_id))
        return _session_dict(_session_row(conn, session_id))


def clean_note(note: Any) -> str | None:
    if note is None:
        return None
    if not isinstance(note, str):
        raise Invalid("re-entry note must be text")
    note = " ".join(note.split())  # one line
    if len(note) > MAX_NOTE:
        raise Invalid(f"re-entry note must be at most {MAX_NOTE} characters")
    return note or None


def end_session(conn: sqlite3.Connection, session_id: int, words_end: Any = None, reentry_note: Any = None) -> dict:
    with tx(conn):
        row = _session_row(conn, session_id)
        _session_kind_check(conn, row["document_id"])
        note = clean_note(reentry_note)
        if row["ended_at"]:
            # Ending twice (e.g. a beacon and then the prompt) only adds the note.
            if note:
                conn.execute("UPDATE sessions SET reentry_note = ? WHERE id = ?", (note, session_id))
        else:
            conn.execute(
                "UPDATE sessions SET ended_at = ?, words_end = ?, reentry_note = ? WHERE id = ?",
                (clock.iso(), _words(words_end), note, session_id),
            )
        return _session_dict(_session_row(conn, session_id))


def list_sessions(conn: sqlite3.Connection, doc_id: int) -> list[dict]:
    doc_row(conn, doc_id)
    rows = conn.execute(
        "SELECT * FROM sessions WHERE document_id = ? ORDER BY started_at DESC LIMIT 50", (doc_id,)
    ).fetchall()
    return [_session_dict(r) for r in rows]


def full_document(conn: sqlite3.Connection, doc_id: int) -> dict:
    return doc_full(doc_row(conn, doc_id))

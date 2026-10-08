"""Key-derivation parameters for encrypted kinds, and passphrase changes.

The browser derives an AES-GCM key from the passphrase with PBKDF2-SHA256
using the salt and iteration count stored here. ``check_envelope`` is a
known value encrypted with that key, so a wrong passphrase can be told apart
from a right one without the server learning anything.
"""

from __future__ import annotations

import base64
import binascii
import sqlite3
from typing import Any

from . import clock, content
from .errors import Conflict, Forbidden, Invalid, NotFound
from .library import require_kind, tx

KDF = "PBKDF2-SHA256"
MIN_ITERATIONS = 100_000
MAX_ITERATIONS = 10_000_000


def _encrypted_kind(kind_id: str):
    kind = require_kind(kind_id)
    if not kind.encrypted:
        raise Forbidden(f"{kind.label} is not an encrypted kind")
    return kind


def _vault_dict(row: sqlite3.Row) -> dict:
    return {
        "kind": row["kind"],
        "kdf": row["kdf"],
        "iterations": row["iterations"],
        "salt": row["salt"],
        "check_envelope": row["check_envelope"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def get_vault(conn: sqlite3.Connection, kind_id: str) -> dict | None:
    _encrypted_kind(kind_id)
    row = conn.execute("SELECT * FROM vaults WHERE kind = ?", (kind_id,)).fetchone()
    return _vault_dict(row) if row else None


def _params(p: dict) -> tuple[str, int, str, str]:
    if p.get("kdf", KDF) != KDF:
        raise Invalid(f"kdf must be {KDF}")
    iterations = p.get("iterations")
    if not isinstance(iterations, int) or isinstance(iterations, bool) or not MIN_ITERATIONS <= iterations <= MAX_ITERATIONS:
        raise Invalid(f"iterations must be between {MIN_ITERATIONS} and {MAX_ITERATIONS}")
    salt = p.get("salt")
    try:
        raw = base64.b64decode(salt, validate=True) if isinstance(salt, str) else b""
    except (binascii.Error, ValueError):
        raw = b""
    if len(raw) < 16:
        raise Invalid("salt must be at least 16 random bytes, base64 encoded")
    check = content.validate_envelope(p.get("check_envelope") or "")
    return KDF, iterations, salt, check


def create_vault(conn: sqlite3.Connection, kind_id: str, payload: Any) -> dict:
    _encrypted_kind(kind_id)
    if not isinstance(payload, dict):
        raise Invalid("expected a JSON object")
    kdf, iterations, salt, check = _params(payload)
    with tx(conn):
        if conn.execute("SELECT 1 FROM vaults WHERE kind = ?", (kind_id,)).fetchone():
            raise Conflict("this kind already has a passphrase; change it instead")
        ts = clock.iso()
        conn.execute(
            "INSERT INTO vaults (kind, kdf, iterations, salt, check_envelope, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (kind_id, kdf, iterations, salt, check, ts, ts),
        )
        return get_vault(conn, kind_id)  # type: ignore[return-value]


def encrypted_items(conn: sqlite3.Connection, kind_id: str) -> dict:
    """Every ciphertext belonging to a kind (including trash), for re-keying."""
    _encrypted_kind(kind_id)
    docs = conn.execute("SELECT id, content_json FROM documents WHERE kind = ?", (kind_id,)).fetchall()
    snaps = conn.execute(
        "SELECT s.id, s.content_json FROM snapshots s JOIN documents d ON d.id = s.document_id WHERE d.kind = ?",
        (kind_id,),
    ).fetchall()
    return {
        "documents": {str(r["id"]): r["content_json"] for r in docs},
        "snapshots": {str(r["id"]): r["content_json"] for r in snaps},
    }


def rekey(conn: sqlite3.Connection, kind_id: str, payload: Any) -> dict:
    """Replace the vault and every ciphertext of the kind in one transaction.

    The client must send a new envelope for every document and snapshot of
    the kind; anything missing or extra is refused so nothing is left
    encrypted under the old key.
    """
    _encrypted_kind(kind_id)
    if not isinstance(payload, dict):
        raise Invalid("expected a JSON object")
    kdf, iterations, salt, check = _params(payload.get("vault") or {})
    docs = payload.get("documents")
    snaps = payload.get("snapshots")
    if not isinstance(docs, dict) or not isinstance(snaps, dict):
        raise Invalid("documents and snapshots must be objects of id -> envelope")
    with tx(conn):
        if not conn.execute("SELECT 1 FROM vaults WHERE kind = ?", (kind_id,)).fetchone():
            raise NotFound("no passphrase set for this kind")
        current = encrypted_items(conn, kind_id)
        if set(docs) != set(current["documents"]) or set(snaps) != set(current["snapshots"]):
            raise Conflict("entries changed while re-encrypting; try again")
        for doc_id, env in docs.items():
            conn.execute("UPDATE documents SET content_json = ? WHERE id = ?", (content.validate_envelope(env), int(doc_id)))
        for snap_id, env in snaps.items():
            conn.execute("UPDATE snapshots SET content_json = ? WHERE id = ?", (content.validate_envelope(env), int(snap_id)))
        conn.execute(
            "UPDATE vaults SET kdf = ?, iterations = ?, salt = ?, check_envelope = ?, updated_at = ? WHERE kind = ?",
            (kdf, iterations, salt, check, clock.iso(), kind_id),
        )
        return get_vault(conn, kind_id)  # type: ignore[return-value]

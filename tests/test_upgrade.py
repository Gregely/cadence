"""Upgrading an existing database: nothing is lost or altered.

A database is built at the schema of the last release before document roles
(migrations 0001-0003), filled with every kind including diary ciphertext,
copied, and upgraded. Every row and column that existed before must be
byte-for-byte the same afterwards.
"""

import json
import shutil
import sqlite3

import pytest
from fastapi.testclient import TestClient

import cadence.db as db
from cadence.app import create_app
from tests.crypto_helpers import envelope, open_envelope, vault_payload

OLD_VERSION = 3


def build_old_database(path, monkeypatch):
    old = [(v, p) for v, p in db.available_migrations() if v <= OLD_VERSION]
    with monkeypatch.context() as m:
        m.setattr(db, "available_migrations", lambda: old)
        conn = db.open_db(path)
    ts = "2026-01-02T03:04:05.000Z"
    doc = lambda text: json.dumps({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]})
    rows = [
        ("essay", None, "Walking", doc("The heron waited."), "The heron waited.", "draft", '{"word_target": 1500, "cursor": 7}'),
        ("note", None, "", doc("a note"), "a note", None, "{}"),
        ("poetry", None, "Heron", doc("grey\twaiting"), "grey\twaiting", None, "{}"),
        ("fiction", 1, "Arrival", doc("She came by train."), "She came by train.", None, "{}"),
        ("fiction", 1, "Night", doc("It was late."), "It was late.", None, '{"word_target": 2000}'),
        ("diary", None, "Entry 2026-01-02", envelope("secret marmalade"), "", None, '{"cursor": 3}'),
    ]
    conn.execute("INSERT INTO folders (kind, parent_id, name, sort_order, created_at, updated_at) VALUES ('fiction', NULL, 'The Novel', 0, ?, ?)", (ts, ts))
    for i, (kind, folder, title, content, text, status, meta) in enumerate(rows):
        conn.execute(
            "INSERT INTO documents (kind, folder_id, sort_order, title, content_json, plain_text, status, meta_json,"
            " created_at, updated_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (kind, folder, i, title, content, text, status, meta, ts, ts, ts),
        )
    from cadence import clock

    # One in the trash (recently, so start-up does not purge it).
    conn.execute("UPDATE documents SET deleted_at = ? WHERE title = 'Night'", (clock.iso(),))
    conn.execute("INSERT INTO vaults (kind, kdf, iterations, salt, check_envelope, created_at, updated_at)"
                 " VALUES ('diary', ?, ?, ?, ?, ?, ?)", (*[vault_payload()[k] for k in ("kdf", "iterations", "salt", "check_envelope")], ts, ts))
    conn.execute("INSERT INTO snapshots (document_id, label, content_json, created_at) VALUES (6, 'Snapshot', ?, ?)", (envelope("older secret"), ts))
    conn.execute("INSERT INTO snapshots (document_id, label, content_json, created_at) VALUES (1, 'v1', ?, ?)", (doc("v1"), ts))
    conn.execute("INSERT INTO sessions (document_id, started_at, ended_at, words_start, words_end, reentry_note) VALUES (4, ?, ?, 1, 4, 'the letter')", (ts, ts))
    conn.execute("INSERT INTO inbox (text, from_kind, created_at) VALUES ('captured', 'essay', ?)", (ts,))
    conn.execute("INSERT INTO sources (title, created_at, updated_at) VALUES ('S', ?, ?)", (ts, ts))
    conn.execute("INSERT INTO clips (source_id, quote, created_at) VALUES (1, 'q', ?)", (ts,))
    conn.execute("INSERT INTO clip_documents (clip_id, document_id, created_at) VALUES (1, 1, ?)", (ts,))
    conn.close()


def dump(path) -> dict:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        " AND name NOT LIKE 'documents_fts%' AND name != 'schema_migrations'")]
    out = {t: [dict(r) for r in conn.execute(f"SELECT * FROM {t} ORDER BY rowid")] for t in tables}
    conn.close()
    return out


def test_upgrade_keeps_every_row_and_value(tmp_path, monkeypatch):
    old = tmp_path / "old.sqlite3"
    build_old_database(old, monkeypatch)
    before = dump(old)
    copy = tmp_path / "upgraded.sqlite3"
    shutil.copy(old, copy)

    applied = db.migrate(db.connect(copy))
    assert min(applied) == OLD_VERSION + 1
    after = dump(copy)

    for table, rows in before.items():
        assert len(after[table]) == len(rows), table
        for old_row, new_row in zip(rows, after[table]):
            for col, value in old_row.items():
                assert new_row[col] == value, (table, col)
    # The only change: fiction documents got the default role; others none.
    roles = {r["title"]: r["role"] for r in after["documents"]}
    assert roles == {"Walking": None, "": None, "Heron": None, "Arrival": "scene", "Night": "scene", "Entry 2026-01-02": None}
    # Diary ciphertext still opens with the same key, and holds no plain text.
    diary = next(r for r in after["documents"] if r["kind"] == "diary")
    assert open_envelope(diary["content_json"])["doc"]["content"][0]["content"][0]["text"] == "secret marmalade"
    assert diary["plain_text"] == "" and b"marmalade" not in copy.read_bytes()
    # The untouched original is still at the old version.
    assert sqlite3.connect(old).execute("SELECT max(version) FROM schema_migrations").fetchone()[0] == OLD_VERSION


def test_upgraded_database_works_through_the_api(tmp_path, monkeypatch):
    path = tmp_path / "old.sqlite3"
    build_old_database(path, monkeypatch)
    with TestClient(create_app(path, static_dir=tmp_path)) as c:
        tree = c.get("/api/kinds/fiction/tree").json()
        assert [(d["title"], d["role"]) for d in tree["documents"]] == [("Arrival", "scene")]
        hits = c.get("/api/search", params={"q": "train", "kind": "fiction"}).json()
        assert [h["title"] for h in hits] == ["Arrival"]
        assert c.get("/api/search", params={"q": "late", "kind": "fiction"}).json() == []  # trashed stays out
        assert c.get("/api/search", params={"q": "marmalade", "all_kinds": "true"}).json() == []
        opened = c.post("/api/documents/4/open").json()
        assert opened["reentry_note"] == "the letter"
        restored = c.post("/api/trash/documents/5/restore")
        assert restored.status_code == 200, restored.text
        assert restored.json()["role"] == "scene"

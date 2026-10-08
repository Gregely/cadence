"""The encrypted diary: the server only ever holds ciphertext."""

import base64
import io
import json
import sqlite3
import zipfile

import pytest

from cadence.backup import backup
from tests.crypto_helpers import envelope, open_envelope, vault_key, vault_payload

SECRET = "the heron knows my secret marmalade"
MARKERS = [b"heron", b"marmalade", "marmalade".encode("utf-16-le")]


def scan(blob: bytes) -> list[bytes]:
    return [m for m in MARKERS if m in blob]


# ------------------------------------------------------------- vault


def test_vault_setup_once(api):
    assert api.ok(api.c.get("/api/vaults/diary")) == {"vault": None}
    v = api.ok(api.c.post("/api/vaults/diary", json=vault_payload()))
    assert v["kdf"] == "PBKDF2-SHA256" and v["iterations"] == 100_000
    assert api.c.post("/api/vaults/diary", json=vault_payload("other")).status_code == 409
    got = api.ok(api.c.get("/api/vaults/diary"))["vault"]
    # The check value opens with the right key only.
    assert open_envelope(got["check_envelope"], vault_key()) == {"check": "cadence"}


def test_vault_validation(api):
    weak = vault_payload()
    weak["iterations"] = 1000
    assert api.c.post("/api/vaults/diary", json=weak).status_code == 422
    short_salt = vault_payload()
    short_salt["salt"] = base64.b64encode(b"short").decode()
    assert api.c.post("/api/vaults/diary", json=short_salt).status_code == 422
    plain_check = vault_payload()
    plain_check["check_envelope"] = json.dumps({"check": "cadence"})
    assert api.c.post("/api/vaults/diary", json=plain_check).status_code == 422
    assert api.c.post("/api/vaults/essay", json=vault_payload()).status_code == 400


def test_no_entries_before_a_passphrase(api):
    r = api.c.post("/api/documents", json={"kind": "diary", "content_json": envelope("x")})
    assert r.status_code == 400


# ------------------------------------------------------------- API refuses plain text


def test_api_rejects_plain_text_for_encrypted_kinds(api, diary):
    r = api.c.post("/api/documents", json={"kind": "diary", "plain_text": SECRET, "content_json": envelope("x")})
    assert r.status_code == 422 and SECRET not in r.text
    r = api.c.post("/api/documents", json={"kind": "diary", "plain_text": SECRET})
    assert r.status_code == 422 and SECRET not in r.text
    entry = diary("x")
    r = api.c.patch(f"/api/documents/{entry['id']}", json={"plain_text": SECRET})
    assert r.status_code == 422 and SECRET not in r.text
    r = api.c.patch(f"/api/documents/{entry['id']}", json={"content_json": envelope("y"), "plain_text": SECRET})
    assert r.status_code == 422


def test_api_rejects_unencrypted_content(api, diary):
    doc = json.dumps({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": SECRET}]}]})
    r = api.c.post("/api/documents", json={"kind": "diary", "content_json": doc})
    assert r.status_code == 422 and SECRET not in r.text
    entry = diary("x")
    r = api.c.patch(f"/api/documents/{entry['id']}", json={"content_json": doc})
    assert r.status_code == 422 and SECRET not in r.text
    # An envelope with extra fields (e.g. a smuggled preview) is refused too.
    env = json.loads(envelope("x"))
    env["preview"] = SECRET
    r = api.c.patch(f"/api/documents/{entry['id']}", json={"content_json": json.dumps(env)})
    assert r.status_code == 422 and SECRET not in r.text
    # Snapshots of encrypted kinds must be envelopes as well.
    r = api.c.post(f"/api/documents/{entry['id']}/snapshots", json={"content_json": doc})
    assert r.status_code == 422 and SECRET not in r.text


def test_titles_status_and_meta_cannot_carry_text(api, diary):
    r = api.c.post("/api/documents", json={"kind": "diary", "title": SECRET, "content_json": envelope("x")})
    assert r.status_code == 422 and SECRET not in r.text
    entry = diary("x")
    assert entry["title"].startswith("Entry ")  # generic and dated
    for body in ({"title": SECRET}, {"status": "draft"}, {"meta": {"mood": SECRET}}, {"meta": {"word_target": 10}}):
        r = api.c.patch(f"/api/documents/{entry['id']}", json=body)
        assert r.status_code == 422, body
        assert SECRET not in r.text
    assert api.c.patch(f"/api/documents/{entry['id']}", json={"meta": {"cursor": 12}}).status_code == 200


def test_entries_round_trip_as_ciphertext(api, diary):
    entry = diary(SECRET)
    got = api.ok(api.c.get(f"/api/documents/{entry['id']}"))
    assert "plain_text" not in got and "excerpt" not in got and "words" not in got
    assert scan(json.dumps(got).encode()) == []
    assert open_envelope(got["content_json"])["doc"]["content"][0]["content"][0]["text"] == SECRET
    tree = api.ok(api.c.get("/api/kinds/diary/tree"))
    assert scan(json.dumps(tree).encode()) == []


# ------------------------------------------------------------- search and inbox


def test_diary_never_in_search_or_inbox_review(api, diary, db_path):
    diary(SECRET)
    for q in ("heron", "marmalade", "secret", "entry"):
        assert api.ok(api.c.get("/api/search", params={"q": q, "all_kinds": "true"})) == []
    assert api.c.get("/api/search", params={"q": "heron", "kind": "diary"}).status_code == 422
    # Capture from the diary is refused, so review can never show diary text.
    assert api.c.post("/api/inbox", json={"text": SECRET, "from_kind": "diary"}).status_code == 400
    # Even a row planted directly in the database is hidden from review.
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO inbox (text, from_kind, created_at) VALUES (?, 'diary', '2026-01-01T00:00:00.000Z')", (SECRET,))
    conn.commit()
    planted = conn.execute("SELECT id FROM inbox").fetchone()[0]
    conn.close()
    for handled in ("false", "true"):
        assert api.ok(api.c.get("/api/inbox", params={"include_handled": handled})) == []
    assert api.c.patch(f"/api/inbox/{planted}", json={"handled": True}).status_code == 404
    conn = sqlite3.connect(db_path)
    assert conn.execute("SELECT count(*) FROM documents_fts").fetchone()[0] == 0
    conn.close()


# ------------------------------------------------------------- backups and exports


def test_backups_contain_only_ciphertext(api, diary, db_path, tmp_path):
    entry = diary(SECRET)
    api.ok(api.c.post(f"/api/documents/{entry['id']}/snapshots", json={"label": "v1"}))
    api.ok(api.c.patch(f"/api/documents/{entry['id']}", json={"content_json": envelope(SECRET + " again")}))
    # Rejected attempts must leave nothing behind either.
    api.c.patch(f"/api/documents/{entry['id']}", json={"plain_text": SECRET})
    api.c.post("/api/inbox", json={"text": SECRET, "from_kind": "diary"})
    out = backup(db_path, tmp_path / "backups")
    blob = out.read_bytes()
    assert scan(blob) == []
    conn = sqlite3.connect(out)
    for (content,) in conn.execute("SELECT content_json FROM documents WHERE kind = 'diary'"):
        assert set(json.loads(content)) == {"v", "alg", "iv", "ct"}
    for (content,) in conn.execute("SELECT content_json FROM snapshots"):
        assert set(json.loads(content)) == {"v", "alg", "iv", "ct"}
    assert conn.execute("SELECT plain_text FROM documents WHERE kind = 'diary'").fetchone()[0] == ""
    conn.close()
    # The live database file and its WAL hold no plaintext either.
    for suffix in ("", "-wal"):
        path = db_path.with_name(db_path.name + suffix)
        if path.exists():
            assert scan(path.read_bytes()) == [], suffix


def test_full_export_contains_only_ciphertext(api, diary):
    diary(SECRET)
    r = api.c.get("/api/export/full")
    z = zipfile.ZipFile(io.BytesIO(r.content))
    for name in z.namelist():
        assert scan(z.read(name)) == [], name
    assert not any(n.startswith("documents/diary") for n in z.namelist())


# ------------------------------------------------------------- passphrase change


def test_rekey_replaces_every_ciphertext_atomically(api, diary):
    a = diary("first entry")
    b = diary("second entry")
    snap = api.ok(api.c.post(f"/api/documents/{a['id']}/snapshots", json={"label": "s"}))
    api.ok(api.c.delete(f"/api/documents/{b['id']}"))  # trashed entries are re-keyed too
    items = api.ok(api.c.get("/api/vaults/diary/items"))
    assert set(items["documents"]) == {str(a["id"]), str(b["id"])}
    assert set(items["snapshots"]) == {str(snap["id"])}

    new_key = vault_key("a new passphrase", 100_000)
    new_vault = vault_payload("a new passphrase")

    def reenc(raw):
        return envelope(open_envelope(raw, vault_key())["doc"]["content"][0]["content"][0]["text"], new_key)

    docs = {k: reenc(v) for k, v in items["documents"].items()}
    snaps = {k: reenc(v) for k, v in items["snapshots"].items()}
    # Missing an item is refused and changes nothing.
    partial = dict(docs)
    partial.pop(str(b["id"]))
    r = api.c.post("/api/vaults/diary/rekey", json={"vault": new_vault, "documents": partial, "snapshots": snaps})
    assert r.status_code == 409
    assert api.ok(api.c.get("/api/vaults/diary/items")) == items
    api.ok(api.c.post("/api/vaults/diary/rekey", json={"vault": new_vault, "documents": docs, "snapshots": snaps}))
    after = api.ok(api.c.get("/api/vaults/diary/items"))
    for raw in list(after["documents"].values()) + list(after["snapshots"].values()):
        open_envelope(raw, new_key)
        with pytest.raises(Exception):
            open_envelope(raw, vault_key())
    vault = api.ok(api.c.get("/api/vaults/diary"))["vault"]
    assert open_envelope(vault["check_envelope"], new_key) == {"check": "cadence"}


def test_snapshot_labels_cannot_carry_text(api, diary):
    entry = diary("x")
    snap = api.ok(api.c.post(f"/api/documents/{entry['id']}/snapshots", json={"label": SECRET}))
    assert snap["label"].startswith("Snapshot ") and "heron" not in snap["label"]
    r = api.c.patch(f"/api/snapshots/{snap['id']}", json={"label": SECRET})
    assert r.status_code == 400 and SECRET not in r.text


def test_error_messages_never_echo_values(api, diary):
    entry = diary("x")
    for body in ({"status": SECRET}, {SECRET: 1}):
        r = api.c.patch(f"/api/documents/{entry['id']}", json=body)
        assert r.status_code == 422 and "heron" not in r.text, body
    bad = json.dumps({"type": "doc", "content": [{"type": SECRET}]})
    r = api.c.post("/api/documents", json={"kind": "essay", "content_json": bad})
    assert r.status_code == 422 and "heron" not in r.text
    r = api.c.post("/api/documents", json={"kind": SECRET})
    assert r.status_code == 422 and "heron" not in r.text

import json

from tests.conftest import doc_json


# ------------------------------------------------------------- snapshots


def test_snapshot_create_list_restore(api):
    d = api.doc("poetry", "Poem", "first version")
    s1 = api.ok(api.c.post(f"/api/documents/{d['id']}/snapshots", json={"label": "  First   draft "}))
    assert s1["label"] == "First draft"
    api.ok(api.c.patch(f"/api/documents/{d['id']}", json={"content_json": doc_json("second version")}))
    snaps = api.ok(api.c.get(f"/api/documents/{d['id']}/snapshots"))
    assert [s["label"] for s in snaps] == ["First draft"]
    full = api.ok(api.c.get(f"/api/snapshots/{s1['id']}"))
    assert "first version" in full["content_json"]
    restored = api.ok(api.c.post(f"/api/snapshots/{s1['id']}/restore"))
    assert restored["plain_text"] == "first version"
    # The overwritten text was kept as a snapshot.
    snaps = api.ok(api.c.get(f"/api/documents/{d['id']}/snapshots"))
    assert snaps[0]["label"].startswith("Before restoring")
    before = api.ok(api.c.get(f"/api/snapshots/{snaps[0]['id']}"))
    assert "second version" in before["content_json"]


def test_snapshot_default_label_and_conflict_copy(api):
    d = api.doc("essay", "x", "server")
    s = api.ok(api.c.post(f"/api/documents/{d['id']}/snapshots", json={}))
    assert s["label"].startswith("Snapshot ")
    c = api.ok(api.c.post(f"/api/documents/{d['id']}/snapshots", json={"label": "Conflict copy", "content_json": doc_json("mine")}))
    assert "mine" in api.ok(api.c.get(f"/api/snapshots/{c['id']}"))["content_json"]
    bad = api.c.post(f"/api/documents/{d['id']}/snapshots", json={"content_json": '{"type":"doc","content":[{"type":"table"}]}'})
    assert bad.status_code == 422


def test_snapshot_rename_delete(api):
    d = api.doc("essay", "x", "y")
    s = api.ok(api.c.post(f"/api/documents/{d['id']}/snapshots", json={"label": "a"}))
    assert api.ok(api.c.patch(f"/api/snapshots/{s['id']}", json={"label": "b"}))["label"] == "b"
    api.ok(api.c.delete(f"/api/snapshots/{s['id']}"))
    assert api.ok(api.c.get(f"/api/documents/{d['id']}/snapshots")) == []


# ------------------------------------------------------------- inbox


def test_capture_and_review(api):
    item = api.ok(api.c.post("/api/inbox", json={"text": "  idea about tides ", "from_kind": "essay"}))
    assert item["text"] == "idea about tides" and item["from_kind"] == "essay"
    assert [i["id"] for i in api.ok(api.c.get("/api/inbox"))] == [item["id"]]
    api.ok(api.c.patch(f"/api/inbox/{item['id']}", json={"handled": True}))
    assert api.ok(api.c.get("/api/inbox")) == []
    assert len(api.ok(api.c.get("/api/inbox", params={"include_handled": "true"}))) == 1
    api.ok(api.c.delete(f"/api/inbox/{item['id']}"))
    assert api.ok(api.c.get("/api/inbox", params={"include_handled": "true"})) == []


def test_capture_validation(api):
    assert api.c.post("/api/inbox", json={"text": "   "}).status_code == 422
    assert api.c.post("/api/inbox", json={"text": "x" * 5000}).status_code == 422
    assert api.c.post("/api/inbox", json={"text": "x", "from_kind": "nope"}).status_code == 422
    assert api.c.post("/api/inbox", json={"text": "untagged"}).status_code == 201


def test_capture_refused_in_diary(api):
    r = api.c.post("/api/inbox", json={"text": "private thought", "from_kind": "diary"})
    assert r.status_code == 400
    assert "private thought" not in r.text
    assert api.ok(api.c.get("/api/inbox", params={"include_handled": "true"})) == []


def test_inbox_to_new_document_and_append(api):
    item = api.ok(api.c.post("/api/inbox", json={"text": "A line worth keeping", "from_kind": "note"}))
    doc = api.ok(api.c.post(f"/api/inbox/{item['id']}/to-document", json={"kind": "note"}))
    assert doc["plain_text"] == "A line worth keeping"
    assert doc["title"] == ""  # notes have optional titles
    assert api.ok(api.c.get("/api/inbox")) == []
    essay = api.doc("essay", "Tides", "Opening.")
    item2 = api.ok(api.c.post("/api/inbox", json={"text": "Moon pulls water"}))
    out = api.ok(api.c.post(f"/api/inbox/{item2['id']}/to-document", json={"kind": "essay", "document_id": essay["id"]}))
    assert out["plain_text"] == "Opening.\n\nMoon pulls water"
    item3 = api.ok(api.c.post("/api/inbox", json={"text": "x"}))
    assert api.c.post(f"/api/inbox/{item3['id']}/to-document", json={"kind": "diary"}).status_code == 400


# ------------------------------------------------------------- sessions


def test_reentry_note_returned_on_next_open(api):
    d = api.doc("fiction", "Chapter 1", "It was late.")
    opened = api.ok(api.c.post(f"/api/documents/{d['id']}/open"))
    assert opened["reentry_note"] is None
    s = api.ok(api.c.post("/api/sessions", json={"document_id": d["id"], "words_start": 3}))
    api.ok(api.c.post(f"/api/sessions/{s['id']}/checkpoint", json={"feeling": "flowing"}))
    api.ok(api.c.post(f"/api/sessions/{s['id']}/checkpoint", json={"feeling": "fighting"}))
    assert api.c.post(f"/api/sessions/{s['id']}/checkpoint", json={"feeling": "meh"}).status_code == 422
    ended = api.ok(api.c.post(f"/api/sessions/{s['id']}/end", json={"words_end": 400, "reentry_note": "Next:\nthe   letter arrives"}))
    assert ended["reentry_note"] == "Next: the letter arrives"  # one line
    assert [c["feeling"] for c in ended["checkpoints"]] == ["flowing", "fighting"]
    opened = api.ok(api.c.post(f"/api/documents/{d['id']}/open"))
    assert opened["reentry_note"] == "Next: the letter arrives"
    assert opened["reentry_note_at"] == ended["ended_at"]


def test_reentry_note_latest_wins_and_end_is_idempotent(api):
    d = api.doc("essay", "x", "y")
    s1 = api.ok(api.c.post("/api/sessions", json={"document_id": d["id"]}))
    api.ok(api.c.post(f"/api/sessions/{s1['id']}/end", json={"reentry_note": "old"}))
    s2 = api.ok(api.c.post("/api/sessions", json={"document_id": d["id"]}))
    api.ok(api.c.post(f"/api/sessions/{s2['id']}/end", json={"words_end": 10}))
    # A note added after a silent end (e.g. the prompt after a page-hide beacon).
    api.ok(api.c.post(f"/api/sessions/{s2['id']}/end", json={"reentry_note": "new"}))
    assert api.ok(api.c.post(f"/api/documents/{d['id']}/open"))["reentry_note"] == "new"
    assert api.c.post(f"/api/sessions/{s2['id']}/end", json={"reentry_note": "x" * 281}).status_code == 422


def test_sessions_refused_for_diary_and_notes(api, diary):
    entry = diary("x")
    assert api.c.post("/api/sessions", json={"document_id": entry["id"]}).status_code == 400
    note = api.doc("note", "", "x")
    assert api.c.post("/api/sessions", json={"document_id": note["id"]}).status_code == 400

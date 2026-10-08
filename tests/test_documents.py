import json

from tests.conftest import doc_json


def test_create_and_read_document(api):
    d = api.doc("essay", "First", "Hello world")
    assert d["title"] == "First"
    got = api.ok(api.c.get(f"/api/documents/{d['id']}"))
    assert got["plain_text"] == "Hello world"
    assert got["words"] == 2
    assert json.loads(got["content_json"])["type"] == "doc"


def test_plain_text_derived_from_content(api):
    d = api.doc("essay", "x", "Typed words", plain_text="something else")
    assert d["plain_text"] == "Typed words"


def test_plain_text_only_creates_paragraphs(api):
    d = api.ok(api.c.post("/api/documents", json={"kind": "note", "plain_text": "one\n\ntwo"}))
    doc = json.loads(d["content_json"])
    assert len(doc["content"]) == 2


def test_kind_restricts_node_types(api):
    heading = json.dumps({"type": "doc", "content": [{"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "H"}]}]})
    assert api.c.post("/api/documents", json={"kind": "essay", "content_json": heading}).status_code == 201
    # Poetry allows italics only: no headings, no bold.
    assert api.c.post("/api/documents", json={"kind": "poetry", "content_json": heading}).status_code == 422
    bold = json.dumps({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "b", "marks": [{"type": "bold"}]}]}]})
    assert api.c.post("/api/documents", json={"kind": "poetry", "content_json": bold}).status_code == 422
    h1 = heading.replace('"level": 2', '"level": 1')
    assert api.c.post("/api/documents", json={"kind": "essay", "content_json": h1}).status_code == 422
    js_link = json.dumps({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "x", "marks": [{"type": "link", "attrs": {"href": "javascript:alert(1)"}}]}]}]})
    assert api.c.post("/api/documents", json={"kind": "essay", "content_json": js_link}).status_code == 422


def test_status_validated(api):
    d = api.doc("essay", "x", "y", status="draft")
    assert d["status"] == "draft"
    assert api.c.patch(f"/api/documents/{d['id']}", json={"status": "published"}).status_code == 422
    n = api.doc("note", "", "n")
    assert api.c.patch(f"/api/documents/{n['id']}", json={"status": "draft"}).status_code == 422


def test_conflict_detection(api):
    d = api.doc("essay", "x", "v1")
    first = api.ok(api.c.patch(f"/api/documents/{d['id']}", json={"content_json": doc_json("v2"), "if_updated_at": d["updated_at"]}))
    stale = api.c.patch(f"/api/documents/{d['id']}", json={"content_json": doc_json("v3"), "if_updated_at": d["updated_at"]})
    assert stale.status_code == 409
    assert api.ok(api.c.get(f"/api/documents/{d['id']}"))["plain_text"] == "v2"
    api.ok(api.c.patch(f"/api/documents/{d['id']}", json={"content_json": doc_json("v3"), "if_updated_at": first["updated_at"]}))


def test_cursor_does_not_bump_updated_at(api):
    d = api.doc("essay", "x", "v1")
    after = api.ok(api.c.patch(f"/api/documents/{d['id']}", json={"meta": {"cursor": 4}}))
    assert after["updated_at"] == d["updated_at"]
    assert after["meta"]["cursor"] == 4


def test_word_target_only_where_enabled(api):
    d = api.doc("essay", "x", "y")
    assert api.ok(api.c.patch(f"/api/documents/{d['id']}", json={"meta": {"word_target": 1500}}))["word_target"] == 1500
    n = api.doc("note", "", "y")
    assert api.c.patch(f"/api/documents/{n['id']}", json={"meta": {"word_target": 10}}).status_code == 422


def test_open_sets_last_opened_and_state(api):
    a = api.doc("essay", "a", "a")
    b = api.doc("poetry", "b", "b")
    assert api.ok(api.c.get("/api/state"))["last_document"] is None
    api.ok(api.c.post(f"/api/documents/{a['id']}/open"))
    api.ok(api.c.post(f"/api/documents/{b['id']}/open"))
    assert api.ok(api.c.get("/api/state"))["last_document"] == {"id": b["id"], "kind": "poetry"}
    assert api.tree("essay")["last_document_id"] == a["id"]


def test_open_returns_folder_path(api):
    a = api.folder("essay", "Series")
    b = api.folder("essay", "Part one", a["id"])
    d = api.doc("essay", "x", "y", folder_id=b["id"])
    opened = api.ok(api.c.post(f"/api/documents/{d['id']}/open"))
    assert [p["name"] for p in opened["folder_path"]] == ["Series", "Part one"]


def test_unknown_update_fields_rejected(api):
    d = api.doc("essay", "x", "y")
    assert api.c.patch(f"/api/documents/{d['id']}", json={"folder_id": None}).status_code == 422
    assert api.c.patch(f"/api/documents/{d['id']}", json={"bogus": 1}).status_code == 422


def test_validation_errors_do_not_echo_input(api):
    secret = "my private sentence"
    r = api.c.post("/api/documents", json={"kind": "essay", "content_json": "{" + secret})
    assert r.status_code == 422
    assert secret not in r.text
    r = api.c.get("/api/search", params={"q": secret, "kind": "essay", "limit": "lots"})
    assert r.status_code == 422
    assert secret not in r.text and "lots" not in r.text


def test_host_header_guard(client):
    assert client.get("/api/kinds", headers={"host": "evil.example"}).status_code == 421
    assert client.get("/api/kinds", headers={"host": "localhost:8765"}).status_code == 200
    assert client.get("/api/kinds", headers={"host": "pi.tail1234.ts.net"}).status_code == 200
    assert client.get("/api/kinds", headers={"host": "100.101.102.103:8765"}).status_code == 200


def test_cross_origin_writes_refused(client):
    r = client.post("/api/inbox", json={"text": "x"}, headers={"origin": "https://evil.example"})
    assert r.status_code == 403
    r = client.post("/api/inbox", content="text=x", headers={"content-type": "text/plain"})
    assert r.status_code == 415


def test_api_responses_not_cached(client):
    r = client.get("/api/kinds")
    assert r.headers["cache-control"] == "no-store"
    assert "connect-src 'self'" in r.headers["content-security-policy"]


def test_stream_newest_first(api):
    from datetime import timedelta

    from cadence import clock

    for i in range(3):
        api.doc("note", "", f"note {i}")
        clock.advance(timedelta(minutes=1))
    out = api.ok(api.c.get("/api/kinds/note/stream", params={"limit": 2}))
    assert [d["plain_text"] for d in out["documents"]] == ["note 2", "note 1"]
    assert out["more"] is True
    out = api.ok(api.c.get("/api/kinds/note/stream", params={"offset": 2, "limit": 2}))
    assert [d["plain_text"] for d in out["documents"]] == ["note 0"] and out["more"] is False

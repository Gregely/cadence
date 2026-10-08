import sqlite3

import pytest

from cadence.kinds import Kind, Tools, register, unregister


def test_search_scoped_to_kind_by_default(api):
    api.doc("essay", "Walking essay", "the heron stood in the reeds")
    api.doc("poetry", "Heron poem", "heron, grey heron")
    hits = api.search("heron", kind="essay")
    assert [h["title"] for h in hits] == ["Walking essay"]
    assert {h["kind"] for h in api.search("heron", all_kinds=True)} == {"essay", "poetry"}
    assert api.c.get("/api/search", params={"q": "heron"}).status_code == 422


def test_search_results_show_folder_path(api):
    a = api.folder("fiction", "The Novel")
    b = api.folder("fiction", "Part Two", a["id"])
    api.doc("fiction", "Scene 4", "lighthouse at dusk", folder_id=b["id"])
    [hit] = api.search("lighthouse", kind="fiction")
    assert hit["folder_path"] == ["The Novel", "Part Two"]
    assert "lighthouse" in hit["snippet"]


def test_prefix_and_punctuation_are_safe(api):
    api.doc("essay", "x", "Typography matters")
    assert len(api.search("typo", kind="essay")) == 1
    for q in ['"', "AND OR NOT", "title:", "*", "(", "NEAR(", "'; drop table documents; --"]:
        r = api.c.get("/api/search", params={"q": q, "kind": "essay"})
        assert r.status_code == 200, q


def test_trashed_documents_never_appear_in_search(api):
    f = api.folder("essay", "F")
    d = api.doc("essay", "Trashed", "zebra crossing")
    e = api.doc("essay", "In folder", "zebra stripes", folder_id=f["id"])
    assert len(api.search("zebra", kind="essay")) == 2
    api.ok(api.c.delete(f"/api/documents/{d['id']}"))
    assert [h["id"] for h in api.search("zebra", kind="essay")] == [e["id"]]
    api.ok(api.c.delete(f"/api/folders/{f['id']}"))
    assert api.search("zebra", kind="essay") == []
    assert api.search("zebra", all_kinds=True) == []
    # Editing a trashed document is impossible, so it cannot sneak back in.
    assert api.c.patch(f"/api/documents/{d['id']}", json={"title": "zebra"}).status_code == 404
    api.ok(api.c.post(f"/api/trash/documents/{d['id']}/restore"))
    assert [h["id"] for h in api.search("zebra", kind="essay")] == [d["id"]]


def test_trashed_documents_not_in_index_after_restart(api, db_path, tmp_path):
    from fastapi.testclient import TestClient

    from cadence.app import create_app

    d = api.doc("essay", "x", "quokka")
    api.ok(api.c.delete(f"/api/documents/{d['id']}"))
    with TestClient(create_app(db_path, tmp_path)) as c2:
        assert c2.get("/api/search", params={"q": "quokka", "kind": "essay"}).json() == []
    conn = sqlite3.connect(db_path)
    assert conn.execute("select count(*) from documents_fts where documents_fts match 'quokka'").fetchone()[0] == 0


@pytest.fixture
def unsearchable_kind():
    kind = register(
        Kind(
            id="scratch",
            label="Scratch",
            extensions=("italic",),
            theme={},
            tools=Tools(),
            searchable=False,
            exportable=False,
            encrypted=False,
            folders_enabled=True,
            list_view="tree",
        )
    )
    yield kind
    unregister("scratch")


def test_unsearchable_kind_never_in_search(api, unsearchable_kind, db_path):
    api.doc("scratch", "pangolin", "pangolin pangolin")
    api.doc("essay", "other", "pangolin")
    assert [h["kind"] for h in api.search("pangolin", all_kinds=True)] == ["essay"]
    assert api.c.get("/api/search", params={"q": "pangolin", "kind": "scratch"}).status_code == 422
    conn = sqlite3.connect(db_path)
    n = conn.execute("select count(*) from documents_fts where documents_fts match 'pangolin'").fetchone()[0]
    assert n == 1  # only the essay was indexed


def test_diary_never_in_search(api, diary):
    diary("secret otter")
    assert api.c.get("/api/search", params={"q": "otter", "kind": "diary"}).status_code == 422
    assert api.search("otter", all_kinds=True) == []
    assert api.search("diary", all_kinds=True) == []
    assert api.search("entry", all_kinds=True) == []


def test_search_scoped_to_a_project_folder(api):
    p1 = api.folder("fiction", "Novel One")
    ch = api.folder("fiction", "Chapter", p1["id"])
    p2 = api.folder("fiction", "Novel Two")
    a = api.doc("fiction", "Deep scene", "lighthouse keeper", folder_id=ch["id"])
    note = api.ok(api.c.post("/api/documents", json={"kind": "fiction", "title": "Keeper notes", "role": "misc", "folder_id": p1["id"], "plain_text": "the lighthouse keeper, age 60"}))
    api.doc("fiction", "Other novel", "lighthouse", folder_id=p2["id"])
    api.doc("fiction", "Loose", "lighthouse")
    hits = api.ok(api.c.get("/api/search", params={"q": "lighthouse", "kind": "fiction", "folder_id": p1["id"]}))
    assert {h["id"] for h in hits} == {a["id"], note["id"]}  # scenes and misc notes, this project only
    by_id = {h["id"]: h for h in hits}
    assert by_id[a["id"]]["folder_path"] == ["Novel One", "Chapter"] and by_id[note["id"]]["role"] == "misc"
    assert len(api.search("lighthouse", kind="fiction")) == 4
    api.ok(api.c.delete(f"/api/folders/{ch['id']}"))
    hits = api.ok(api.c.get("/api/search", params={"q": "lighthouse", "kind": "fiction", "folder_id": p1["id"]}))
    assert [h["id"] for h in hits] == [note["id"]]

from datetime import timedelta

from cadence import clock


def test_soft_delete_and_restore_document(api):
    f = api.folder("essay", "F")
    d = api.doc("essay", "Gone soon", "words", folder_id=f["id"])
    api.ok(api.c.delete(f"/api/documents/{d['id']}"))
    assert api.tree("essay")["documents"] == []
    assert api.c.get(f"/api/documents/{d['id']}").status_code == 404
    trash = api.ok(api.c.get("/api/trash", params={"kind": "essay"}))
    assert [x["id"] for x in trash["documents"]] == [d["id"]]
    api.ok(api.c.post(f"/api/trash/documents/{d['id']}/restore"))
    got = api.ok(api.c.get(f"/api/documents/{d['id']}"))
    assert got["folder_id"] == f["id"]
    assert got["plain_text"] == "words"


def test_restore_document_whose_folder_is_gone_goes_to_root(api):
    f = api.folder("essay", "F")
    d = api.doc("essay", "orphan", "words", folder_id=f["id"])
    api.ok(api.c.delete(f"/api/documents/{d['id']}"))
    api.ok(api.c.delete(f"/api/folders/{f['id']}"))
    api.ok(api.c.post(f"/api/trash/documents/{d['id']}/restore"))
    assert api.ok(api.c.get(f"/api/documents/{d['id']}"))["folder_id"] is None
    # Also when the folder has been purged entirely.
    g = api.folder("essay", "G")
    e = api.doc("essay", "orphan2", "w", folder_id=g["id"])
    api.ok(api.c.delete(f"/api/documents/{e['id']}"))
    api.ok(api.c.delete(f"/api/folders/{g['id']}"))
    api.ok(api.c.delete(f"/api/trash/folders/{g['id']}"))
    api.ok(api.c.post(f"/api/trash/documents/{e['id']}/restore"))
    assert api.ok(api.c.get(f"/api/documents/{e['id']}"))["folder_id"] is None


def test_folder_delete_is_one_batch_and_restores_together(api):
    a = api.folder("fiction", "Novel")
    b = api.folder("fiction", "Part 1", a["id"])
    s1 = api.doc("fiction", "s1", "x", folder_id=b["id"])
    s2 = api.doc("fiction", "s2", "y", folder_id=b["id"])
    loose = api.doc("fiction", "loose", "z", folder_id=a["id"])
    api.ok(api.c.delete(f"/api/folders/{a['id']}"))
    assert api.tree("fiction") == {**api.tree("fiction"), "folders": [], "documents": []}
    trash = api.ok(api.c.get("/api/trash", params={"kind": "fiction"}))
    assert [f["id"] for f in trash["folders"]] == [a["id"]]
    assert trash["folders"][0]["contains"] == {"folders": 1, "documents": 3}
    assert trash["documents"] == []  # inside the folder batch
    api.ok(api.c.post(f"/api/trash/folders/{a['id']}/restore"))
    t = api.tree("fiction")
    assert {f["name"] for f in t["folders"]} == {"Novel", "Part 1"}
    assert api.order("fiction", b["id"]) == ["s1", "s2"]
    assert api.order("fiction", a["id"]) == ["loose"]
    assert {s1["id"], s2["id"], loose["id"]} == {d["id"] for d in t["documents"]}


def test_items_trashed_earlier_stay_trashed_on_folder_restore(api):
    a = api.folder("essay", "A")
    early = api.doc("essay", "early", "x", folder_id=a["id"])
    api.ok(api.c.delete(f"/api/documents/{early['id']}"))
    clock.advance(timedelta(seconds=2))
    api.ok(api.c.delete(f"/api/folders/{a['id']}"))
    api.ok(api.c.post(f"/api/trash/folders/{a['id']}/restore"))
    assert api.order("essay", a["id"]) == []
    assert [d["id"] for d in api.ok(api.c.get("/api/trash"))["documents"]] == [early["id"]]


def test_restore_folder_whose_parent_is_gone(api):
    a = api.folder("essay", "A")
    b = api.folder("essay", "B", a["id"])
    api.ok(api.c.delete(f"/api/folders/{b['id']}"))
    clock.advance(timedelta(seconds=1))
    api.ok(api.c.delete(f"/api/folders/{a['id']}"))
    api.ok(api.c.post(f"/api/trash/folders/{b['id']}/restore"))
    folders = api.tree("essay")["folders"]
    assert [(f["name"], f["parent_id"]) for f in folders] == [("B", None)]


def test_trash_purged_after_30_days(api):
    keep = api.doc("essay", "recent", "x")
    old = api.doc("essay", "old", "y")
    f = api.folder("essay", "oldfolder")
    api.ok(api.c.delete(f"/api/documents/{old['id']}"))
    api.ok(api.c.delete(f"/api/folders/{f['id']}"))
    clock.advance(timedelta(days=29))
    api.ok(api.c.delete(f"/api/documents/{keep['id']}"))
    trash = api.ok(api.c.get("/api/trash"))
    assert len(trash["documents"]) == 2 and len(trash["folders"]) == 1
    clock.advance(timedelta(days=2))
    trash = api.ok(api.c.get("/api/trash"))
    assert [d["id"] for d in trash["documents"]] == [keep["id"]]
    assert trash["folders"] == []
    assert api.c.post(f"/api/trash/documents/{old['id']}/restore").status_code == 404


def test_permanent_delete_only_from_trash(api):
    d = api.doc("essay", "x", "y")
    assert api.c.delete(f"/api/trash/documents/{d['id']}").status_code == 422
    api.ok(api.c.delete(f"/api/documents/{d['id']}"))
    api.ok(api.c.delete(f"/api/trash/documents/{d['id']}"))
    assert api.ok(api.c.get("/api/trash"))["documents"] == []


def test_snapshots_go_with_purged_document(api, db_path):
    import sqlite3

    d = api.doc("essay", "x", "y")
    api.ok(api.c.post(f"/api/documents/{d['id']}/snapshots", json={"label": "v1"}))
    api.ok(api.c.delete(f"/api/documents/{d['id']}"))
    api.ok(api.c.delete(f"/api/trash/documents/{d['id']}"))
    conn = sqlite3.connect(db_path)
    assert conn.execute("select count(*) from snapshots").fetchone()[0] == 0

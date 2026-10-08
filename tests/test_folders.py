"""Folders: nesting, depth, cycles, cross-kind rules and ordering."""


def test_create_nested_folders_and_depth_limit(api):
    a = api.folder("essay", "A")
    b = api.folder("essay", "B", a["id"])
    c = api.folder("essay", "C", b["id"])
    d = api.folder("essay", "D", c["id"])  # depth 4: allowed
    r = api.c.post("/api/folders", json={"kind": "essay", "name": "E", "parent_id": d["id"]})
    assert r.status_code == 422
    assert "4" in r.json()["detail"]


def test_move_enforces_depth_for_whole_subtree(api):
    a = api.folder("essay", "A")
    b = api.folder("essay", "B", a["id"])
    c = api.folder("essay", "C", b["id"])
    x = api.folder("essay", "X")
    y = api.folder("essay", "Y", x["id"])
    # X (height 2) under C (depth 3) would reach depth 5.
    r = api.c.post(f"/api/folders/{x['id']}/move", json={"parent_id": c["id"]})
    assert r.status_code == 422
    # Under B (depth 2) it reaches exactly 4.
    api.ok(api.c.post(f"/api/folders/{x['id']}/move", json={"parent_id": b["id"]}))
    t = api.tree("essay")
    assert {f["name"]: f["parent_id"] for f in t["folders"]}["Y"] == x["id"]


def test_folder_cycles_rejected(api):
    a = api.folder("essay", "A")
    b = api.folder("essay", "B", a["id"])
    c = api.folder("essay", "C", b["id"])
    for target in (a["id"], b["id"], c["id"]):
        r = api.c.post(f"/api/folders/{a['id']}/move", json={"parent_id": target})
        assert r.status_code == 422, target
    r = api.c.post(f"/api/folders/{b['id']}/move", json={"parent_id": c["id"]})
    assert r.status_code == 422
    # Nothing changed.
    t = api.tree("essay")
    parents = {f["name"]: f["parent_id"] for f in t["folders"]}
    assert parents == {"A": None, "B": a["id"], "C": b["id"]}


def test_cross_kind_moves_rejected(api):
    essays = api.folder("essay", "Essays")
    poems = api.folder("poetry", "Poems")
    doc = api.doc("essay", "On walking", "text")
    r = api.c.post(f"/api/documents/{doc['id']}/move", json={"folder_id": poems["id"]})
    assert r.status_code == 400
    r = api.c.post(f"/api/folders/{essays['id']}/move", json={"parent_id": poems["id"]})
    assert r.status_code == 400
    r = api.c.post(f"/api/documents/{doc['id']}/move", json={"folder_id": None, "kind": "poetry"})
    assert r.status_code == 400
    r = api.c.patch(f"/api/documents/{doc['id']}", json={"kind": "poetry"})
    assert r.status_code == 400
    r = api.c.post(f"/api/folders/{essays['id']}/move", json={"parent_id": None, "kind": "poetry"})
    assert r.status_code == 400
    r = api.c.post("/api/documents", json={"kind": "essay", "folder_id": poems["id"]})
    assert r.status_code == 400
    r = api.c.post("/api/folders", json={"kind": "essay", "name": "x", "parent_id": poems["id"]})
    assert r.status_code == 400
    assert api.ok(api.c.get(f"/api/documents/{doc['id']}"))["kind"] == "essay"


def test_diary_has_no_folders(api):
    r = api.c.post("/api/folders", json={"kind": "diary", "name": "Private"})
    assert r.status_code == 400


def test_rename_keeps_content(api):
    f = api.folder("essay", "Drafts")
    doc = api.doc("essay", "Piece", "Body text stays.", folder_id=f["id"])
    api.ok(api.c.patch(f"/api/folders/{f['id']}", json={"name": "Series: Walking"}))
    api.ok(api.c.patch(f"/api/documents/{doc['id']}", json={"title": "Renamed piece"}))
    got = api.ok(api.c.get(f"/api/documents/{doc['id']}"))
    assert got["title"] == "Renamed piece"
    assert "Body text stays." in got["plain_text"]
    assert got["folder_id"] == f["id"]
    assert api.folder_order("essay") == ["Series: Walking"]
    r = api.c.patch(f"/api/folders/{f['id']}", json={"name": "   "})
    assert r.status_code == 422


def test_document_ordering_survives_moves(api):
    f = api.folder("fiction", "Novel")
    other = api.folder("fiction", "Other")
    ids = {}
    for name in ["one", "two", "three", "four"]:
        ids[name] = api.doc("fiction", name, f"{name} text", folder_id=f["id"])["id"]
    assert api.order("fiction", f["id"]) == ["one", "two", "three", "four"]
    # Reorder within the folder: move "four" to the front.
    api.ok(api.c.post(f"/api/documents/{ids['four']}/move", json={"folder_id": f["id"], "index": 0}))
    assert api.order("fiction", f["id"]) == ["four", "one", "two", "three"]
    # Move "one" out to another folder, then back to position 2.
    api.ok(api.c.post(f"/api/documents/{ids['one']}/move", json={"folder_id": other["id"]}))
    assert api.order("fiction", f["id"]) == ["four", "two", "three"]
    assert api.order("fiction", other["id"]) == ["one"]
    api.ok(api.c.post(f"/api/documents/{ids['one']}/move", json={"folder_id": f["id"], "index": 2}))
    assert api.order("fiction", f["id"]) == ["four", "two", "one", "three"]
    # Sort orders are dense after every move.
    t = api.tree("fiction")
    orders = sorted(d["sort_order"] for d in t["documents"] if d["folder_id"] == f["id"])
    assert orders == [0, 1, 2, 3]
    # Moving a folder keeps its documents' order.
    api.ok(api.c.post(f"/api/folders/{f['id']}/move", json={"parent_id": other["id"]}))
    assert api.order("fiction", f["id"]) == ["four", "two", "one", "three"]
    # Content untouched by all of this.
    assert "two text" in api.ok(api.c.get(f"/api/documents/{ids['two']}"))["plain_text"]


def test_folder_ordering(api):
    for name in "ABCD":
        api.folder("poetry", name)
    folders = {f["name"]: f["id"] for f in api.tree("poetry")["folders"]}
    api.ok(api.c.post(f"/api/folders/{folders['D']}/move", json={"parent_id": None, "index": 1}))
    assert api.folder_order("poetry") == ["A", "D", "B", "C"]
    # Indent C into B, then outdent it back after B.
    api.ok(api.c.post(f"/api/folders/{folders['C']}/move", json={"parent_id": folders["B"]}))
    assert api.folder_order("poetry") == ["A", "D", "B"]
    assert api.folder_order("poetry", folders["B"]) == ["C"]
    api.ok(api.c.post(f"/api/folders/{folders['C']}/move", json={"parent_id": None, "index": 3}))
    assert api.folder_order("poetry") == ["A", "D", "B", "C"]


def test_create_at_index(api):
    api.doc("essay", "a")
    api.doc("essay", "c")
    api.ok(api.c.post("/api/documents", json={"kind": "essay", "title": "b", "index": 1}))
    assert api.order("essay") == ["a", "b", "c"]


def test_unknown_kind_rejected(api):
    assert api.c.post("/api/folders", json={"kind": "nope", "name": "x"}).status_code == 422
    assert api.c.post("/api/documents", json={"kind": "nope"}).status_code == 422
    assert api.c.get("/api/kinds/nope/tree").status_code == 422

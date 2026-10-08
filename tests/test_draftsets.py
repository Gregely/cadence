"""Draft sets: whole-project snapshots, compare and restore."""

import json

from tests.test_compile import novel, para  # noqa: F401  (fixture)


def text(api, doc_id):
    return api.ok(api.c.get(f"/api/documents/{doc_id}"))["plain_text"]


def test_take_and_list(api, novel):
    s = api.ok(api.c.post(f"/api/folders/{novel['ch1']['id']}/draft-sets", json={"name": "Draft 1"}))
    assert s["folder_id"] == novel["project"]["id"]  # always the whole project
    assert s["documents"] == 4 and s["automatic"] is False
    listed = api.ok(api.c.get(f"/api/folders/{novel['project']['id']}/draft-sets"))
    assert listed["project"]["name"] == "The Lighthouse" and [x["name"] for x in listed["sets"]] == ["Draft 1"]
    full = api.ok(api.c.get(f"/api/draft-sets/{s['id']}"))
    assert {i["title"] for i in full["items"]} == {"Arrival", "Night", "Mara notes", "Morning"}
    item = api.ok(api.c.get(f"/api/draft-sets/{s['id']}/documents/{novel['a']['id']}"))
    assert "Mara came off the ferry." in item["content_json"]
    assert api.c.post(f"/api/folders/{novel['ch1']['id']}/draft-sets", json={"name": "  "}).status_code == 422


def test_restore_whole_project_after_safety_set(api, novel):
    s = api.ok(api.c.post(f"/api/folders/{novel['project']['id']}/draft-sets", json={"name": "Draft 1"}))
    a, b, c = novel["a"]["id"], novel["b"]["id"], novel["c"]["id"]
    api.ok(api.c.patch(f"/api/documents/{a}", json={"content_json": para("Rewritten arrival."), "title": "Arrival v2"}))
    api.ok(api.c.delete(f"/api/documents/{b}"))  # in the trash
    api.ok(api.c.delete(f"/api/documents/{c}"))
    api.ok(api.c.delete(f"/api/trash/documents/{c}"))  # gone for good
    d = api.ok(api.c.post("/api/documents", json={"kind": "fiction", "title": "New", "folder_id": novel["ch1"]["id"], "content_json": para("Written after.")}))

    out = api.ok(api.c.post(f"/api/draft-sets/{s['id']}/restore", json={}))
    safety = out["safety_set"]
    assert safety["automatic"] is True and safety["name"] == "Before restoring “Draft 1”"
    assert set(out["restored"]) == {a, b} and len(out["recreated"]) == 1
    assert text(api, a) == "Mara came off the ferry.\n\nRain on the quay."
    assert api.ok(api.c.get(f"/api/documents/{a}"))["title"] == "Arrival"
    assert "The lamp" in text(api, b)  # back from the trash
    new_c = out["recreated"][0]
    got = api.ok(api.c.get(f"/api/documents/{new_c}"))
    assert got["title"] == "Morning" and got["folder_id"] == novel["ch2"]["id"]
    assert text(api, d["id"]) == "Written after."  # newer work left alone
    # The safety set holds the state just before the restore.
    safe_item = api.ok(api.c.get(f"/api/draft-sets/{safety['id']}/documents/{a}"))
    assert "Rewritten arrival." in safe_item["content_json"]
    assert {i["document_id"] for i in api.ok(api.c.get(f"/api/draft-sets/{safety['id']}"))["items"]} >= {d["id"]}
    # Search follows the restored text.
    assert [h["id"] for h in api.search("ferry", kind="fiction")] == [a]


def test_restore_one_scene(api, novel):
    s = api.ok(api.c.post(f"/api/folders/{novel['project']['id']}/draft-sets", json={"name": "Draft 1"}))
    a, b = novel["a"]["id"], novel["b"]["id"]
    api.ok(api.c.patch(f"/api/documents/{a}", json={"content_json": para("Changed A.")}))
    api.ok(api.c.patch(f"/api/documents/{b}", json={"content_json": para("Changed B.")}))
    out = api.ok(api.c.post(f"/api/draft-sets/{s['id']}/restore", json={"document_id": a}))
    assert out["restored"] == [a]
    assert text(api, a).startswith("Mara came off") and text(api, b) == "Changed B."
    sets = api.ok(api.c.get(f"/api/folders/{novel['project']['id']}/draft-sets"))["sets"]
    assert [x["automatic"] for x in sets] == [True, False]
    assert api.c.post(f"/api/draft-sets/{s['id']}/restore", json={"document_id": 99999}).status_code == 404


def test_rename_delete_and_cascade(api, novel):
    s = api.ok(api.c.post(f"/api/folders/{novel['project']['id']}/draft-sets", json={"name": "Draft 1"}))
    assert api.ok(api.c.patch(f"/api/draft-sets/{s['id']}", json={"name": "First full draft"}))["name"] == "First full draft"
    api.ok(api.c.delete(f"/api/draft-sets/{s['id']}"))
    assert api.ok(api.c.get(f"/api/folders/{novel['project']['id']}/draft-sets"))["sets"] == []
    s2 = api.ok(api.c.post(f"/api/folders/{novel['project']['id']}/draft-sets", json={"name": "Draft 2"}))
    api.ok(api.c.delete(f"/api/folders/{novel['project']['id']}"))
    api.ok(api.c.delete(f"/api/trash/folders/{novel['project']['id']}"))
    assert api.c.get(f"/api/draft-sets/{s2['id']}").status_code == 404


def test_draft_sets_only_for_kinds_with_the_tool(api, diary):
    f = api.folder("essay", "Series")
    assert api.c.post(f"/api/folders/{f['id']}/draft-sets", json={"name": "x"}).status_code == 400
    assert api.c.get(f"/api/folders/{f['id']}/draft-sets").status_code == 400


def test_full_backup_includes_draft_sets(api, novel):
    import io
    import zipfile

    api.ok(api.c.post(f"/api/folders/{novel['project']['id']}/draft-sets", json={"name": "Draft 1"}))
    data = json.loads(zipfile.ZipFile(io.BytesIO(api.c.get("/api/export/full").content)).read("data.json"))
    assert data["draft_sets"][0]["name"] == "Draft 1" and len(data["draft_set_items"]) == 4


def test_restoring_a_safety_set_names_the_new_one_plainly(api, novel):
    s = api.ok(api.c.post(f"/api/folders/{novel['project']['id']}/draft-sets", json={"name": "Draft 1"}))
    first = api.ok(api.c.post(f"/api/draft-sets/{s['id']}/restore", json={}))["safety_set"]
    second = api.ok(api.c.post(f"/api/draft-sets/{first['id']}/restore", json={}))["safety_set"]
    assert second["name"] == "Before restoring a safety set"

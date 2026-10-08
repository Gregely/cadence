"""Document roles (fiction: scene/misc) and optional per-document details."""

import json

import pytest


def test_fiction_documents_default_to_scene(api):
    d = api.doc("fiction", "Arrival", "text")
    assert d["role"] == "scene"
    m = api.ok(api.c.post("/api/documents", json={"kind": "fiction", "title": "Mara", "role": "misc"}))
    assert m["role"] == "misc"
    tree = api.tree("fiction")
    assert {x["title"]: x["role"] for x in tree["documents"]} == {"Arrival": "scene", "Mara": "misc"}
    changed = api.ok(api.c.patch(f"/api/documents/{d['id']}", json={"role": "misc"}))
    assert changed["role"] == "misc"


def test_invalid_roles_rejected(api):
    assert api.c.post("/api/documents", json={"kind": "fiction", "role": "chapter"}).status_code == 422
    d = api.doc("fiction", "x", "y")
    assert api.c.patch(f"/api/documents/{d['id']}", json={"role": "outline"}).status_code == 422


@pytest.mark.parametrize("kind", ["essay", "note", "poetry"])
def test_other_kinds_have_no_roles(api, kind):
    d = api.doc(kind, "t", "x")
    assert d["role"] is None
    assert api.c.post("/api/documents", json={"kind": kind, "role": "scene"}).status_code == 422
    # As before this change, a role field is an unknown field for these kinds.
    assert api.c.patch(f"/api/documents/{d['id']}", json={"role": "scene"}).status_code == 422
    assert "synopsis" not in d and "story_date" not in d


def test_scene_details_validated_and_listed(api):
    d = api.doc("fiction", "Arrival", "text")
    out = api.ok(api.c.patch(f"/api/documents/{d['id']}", json={"meta": {
        "synopsis": "  Mara arrives\nby the late train ",
        "pov": "Mara",
        "story_date": "1888-03-14T21:30",
        "beats": [{"text": " the train ", "done": True}, {"text": "the letter"}],
    }}))
    assert out["meta"]["synopsis"] == "Mara arrives by the late train"
    assert out["meta"]["beats"] == [{"text": "the train", "done": True}, {"text": "the letter", "done": False}]
    summary = api.tree("fiction")["documents"][0]
    assert summary["synopsis"] == "Mara arrives by the late train"
    assert summary["story_date"] == "1888-03-14T21:30" and summary["pov"] == "Mara"
    assert "beats" not in summary
    for bad in ({"story_date": "next Tuesday"}, {"story_date": "1888-13-01"}, {"synopsis": "x" * 301},
                {"beats": "not a list"}, {"beats": [{"done": True}]}, {"pov": 5}):
        assert api.c.patch(f"/api/documents/{d['id']}", json={"meta": bad}).status_code == 422, bad
    # Clearing a detail removes it.
    out = api.ok(api.c.patch(f"/api/documents/{d['id']}", json={"meta": {"synopsis": "", "pov": None}}))
    assert "synopsis" not in out["meta"] and "pov" not in out["meta"]


def test_fiction_status_symbols_and_statuses(api):
    kinds = {k["id"]: k for k in api.ok(api.c.get("/api/kinds"))}
    f = kinds["fiction"]
    assert f["statuses"] == ["stub", "drafted", "revised", "done"]
    assert len(set(f["status_symbols"].values())) == 4  # a distinct shape for each
    assert [r["id"] for r in f["roles"]] == ["scene", "misc"] and f["default_role"] == "scene"
    d = api.doc("fiction", "x", "y", status="stub")
    assert d["status"] == "stub"
    assert api.c.patch(f"/api/documents/{d['id']}", json={"status": "draft"}).status_code == 422
    # Essays keep their own statuses.
    assert api.doc("essay", "e", "x", status="draft")["status"] == "draft"
    assert kinds["essay"]["roles"] == [] and kinds["essay"]["status_symbols"] == {}

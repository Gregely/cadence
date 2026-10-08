"""Adding a kind is one registry entry; nothing else needs to change."""

import json
import sqlite3

import pytest

from cadence.kinds import KINDS, Kind, Tools, register, unregister


@pytest.fixture
def letters_kind():
    kind = register(
        Kind(
            id="letters",
            label="Letters",
            extensions=("typography", "italic", "bold", "hardBreak"),
            theme={"font_body": "serif", "accent": "#123456"},
            tools=Tools(session_timer=True, reentry="normal"),
            searchable=True,
            exportable=True,
            encrypted=False,
            folders_enabled=True,
            list_view="tree",
            folder_label="Correspondent",
            item_label="Letter",
        )
    )
    yield kind
    unregister("letters")


def test_new_kind_works_end_to_end(api, letters_kind):
    kinds = api.ok(api.c.get("/api/kinds"))
    entry = next(k for k in kinds if k["id"] == "letters")
    assert entry["folder_label"] == "Correspondent"
    assert entry["capture_allowed"] is True

    folder = api.folder("letters", "To Ada")
    doc = api.doc("letters", "Dear Ada", "the garden is full of bees", folder_id=folder["id"])
    assert api.tree("letters")["documents"][0]["id"] == doc["id"]
    assert [h["id"] for h in api.search("bees", kind="letters")] == [doc["id"]]
    assert "letters" in {h["kind"] for h in api.search("bees", all_kinds=True)}

    s = api.ok(api.c.post("/api/sessions", json={"document_id": doc["id"]}))
    api.ok(api.c.post(f"/api/sessions/{s['id']}/end", json={"reentry_note": "reply about the bees"}))
    assert api.ok(api.c.post(f"/api/documents/{doc['id']}/open"))["reentry_note"] == "reply about the bees"
    api.ok(api.c.post("/api/inbox", json={"text": "write to Ada", "from_kind": "letters"}))
    api.ok(api.c.post(f"/api/documents/{doc['id']}/snapshots", json={"label": "v1"}))

    # Its extension list is enforced like any other kind.
    heading = json.dumps({"type": "doc", "content": [{"type": "heading", "attrs": {"level": 2}}]})
    assert api.c.post("/api/documents", json={"kind": "letters", "content_json": heading}).status_code == 422

    # Cross-kind rules apply to it too.
    essay_folder = api.folder("essay", "Essays")
    assert api.c.post(f"/api/documents/{doc['id']}/move", json={"folder_id": essay_folder["id"]}).status_code == 400

    api.ok(api.c.delete(f"/api/folders/{folder['id']}"))
    assert api.search("bees", kind="letters") == []
    api.ok(api.c.post(f"/api/trash/folders/{folder['id']}/restore"))
    assert len(api.search("bees", kind="letters")) == 1


def test_duplicate_kind_rejected():
    with pytest.raises(ValueError):
        register(KINDS["essay"])


def test_builtin_kinds_match_brief():
    essay, note, poetry, diary, fiction = (KINDS[k] for k in ("essay", "note", "poetry", "diary", "fiction"))
    assert essay.statuses == ("idea", "draft", "revising", "done") and essay.tools.research_pane
    assert {"heading:2,3", "bold", "italic", "link", "blockquote", "footnote", "sectionBreak"} <= set(essay.extensions)
    assert note.list_view == "stream" and note.title_mode == "optional" and note.folders_enabled
    assert set(poetry.extensions) - {"typography"} == {"italic", "hardBreak", "poetryLines", "indent"}
    assert poetry.tools.snapshots == "prominent" and poetry.folders_enabled
    assert diary.encrypted and not diary.searchable and not diary.folders_enabled
    assert diary.list_view == "by-month" and not diary.tools.word_count and not diary.capture_allowed
    assert fiction.list_view == "ordered" and fiction.tools.reentry == "prominent" and fiction.folder_label == "Project"


def test_no_kind_ids_hardcoded_in_backend():
    """The backend never branches on a specific kind id outside the registry."""
    from pathlib import Path

    src = Path(__file__).resolve().parent.parent / "cadence"
    offenders = []
    for path in src.glob("*.py"):
        if path.name == "kinds.py":
            continue
        text = path.read_text()
        for kid in ("essay", "poetry", "diary", "fiction"):
            if f'"{kid}"' in text or f"'{kid}'" in text:
                offenders.append((path.name, kid))
    assert offenders == []

import io
import json
import zipfile


def clip(api, quote, doc_ids=(), **source):
    body = {"quote": quote, "page": source.pop("page", ""), "source": source, "document_ids": list(doc_ids)}
    return api.ok(api.c.post("/api/clips", json=body))


def test_clipper_saves_quote_and_source_in_one_step(api):
    essay = api.doc("essay", "Walking", "text")
    c = clip(api, "In wildness is the preservation of the world.", [essay["id"]],
             title="Walking", author="Henry David Thoreau", url="https://example.org/walking", published="1862", page="12")
    assert c["source"]["title"] == "Walking" and c["page"] == "12"
    assert c["document_ids"] == [essay["id"]]
    attached = api.ok(api.c.get(f"/api/documents/{essay['id']}/clips"))
    assert [x["quote"] for x in attached] == ["In wildness is the preservation of the world."]
    assert attached[0]["source"]["author"] == "Henry David Thoreau"


def test_same_source_is_reused(api):
    a = clip(api, "one", title="Walden", author="Thoreau")
    b = clip(api, "two", title="walden", author="THOREAU", url="https://example.org/walden")
    c = clip(api, "three", title="Different title", url="https://example.org/walden")
    assert a["source_id"] == b["source_id"] == c["source_id"]
    src = api.ok(api.c.get(f"/api/sources/{a['source_id']}"))
    assert src["url"] == "https://example.org/walden"  # filled in from the later clip
    assert [x["quote"] for x in src["clips"]] == ["one", "two", "three"]
    assert len(api.ok(api.c.get("/api/sources"))) == 1


def test_clip_validation(api):
    assert api.c.post("/api/clips", json={"quote": "", "source": {"title": "x"}}).status_code == 422
    assert api.c.post("/api/clips", json={"quote": "q", "source": {"title": ""}}).status_code == 422
    assert api.c.post("/api/clips", json={"quote": "q", "source": {"title": "x", "url": "javascript:alert(1)"}}).status_code == 422
    poem = api.doc("poetry", "Poem", "x")
    r = api.c.post("/api/clips", json={"quote": "q", "source": {"title": "x"}, "document_ids": [poem["id"]]})
    assert r.status_code == 400  # poetry has no research tools
    assert api.ok(api.c.get("/api/sources")) == []  # nothing half-saved


def test_attach_detach_and_delete(api):
    a = api.doc("essay", "A", "x")
    b = api.doc("essay", "B", "y")
    c = clip(api, "quote", [a["id"]], title="Source")
    api.ok(api.c.post(f"/api/clips/{c['id']}/documents/{b['id']}"))
    assert len(api.ok(api.c.get(f"/api/documents/{b['id']}/clips"))) == 1
    api.ok(api.c.delete(f"/api/clips/{c['id']}/documents/{a['id']}"))
    assert api.ok(api.c.get(f"/api/documents/{a['id']}/clips")) == []
    api.ok(api.c.delete(f"/api/sources/{c['source_id']}"))
    assert api.ok(api.c.get(f"/api/documents/{b['id']}/clips")) == []


def test_research_search_covers_documents_and_sources_not_diary(api, diary):
    api.doc("essay", "Herons", "the grey heron")
    api.doc("note", "", "heron sighting at the weir")
    clip(api, "A heron is patience with feathers.", title="Birds of the River", author="Ana Sousa")
    diary("heron in my private diary")
    out = api.ok(api.c.get("/api/research/search", params={"q": "heron"}))
    assert {d["kind"] for d in out["documents"]} == {"essay", "note"}
    assert [s["title"] for s in out["sources"]] == ["Birds of the River"]
    assert out["sources"][0]["clips"][0]["quote"].startswith("A heron")
    by_author = api.ok(api.c.get("/api/research/search", params={"q": "sousa"}))
    assert [s["title"] for s in by_author["sources"]] == ["Birds of the River"]
    # Wildcards in the query are literal.
    assert api.ok(api.c.get("/api/sources", params={"q": "%"})) == []


def test_preview_refuses_diary(api, diary):
    e = diary("secret")
    assert api.c.get(f"/api/research/preview/{e['id']}").status_code == 400
    d = api.doc("essay", "Open me", "body")
    assert api.ok(api.c.get(f"/api/research/preview/{d['id']}"))["title"] == "Open me"


def test_reading_notes_template(api):
    c1 = clip(api, "First quote.", title="Walking", author="Thoreau", published="1862", page="4", url="https://example.org/w")
    clip(api, "Second quote.", title="Walking", author="Thoreau")
    doc = api.ok(api.c.post(f"/api/sources/{c1['source_id']}/reading-notes", json={"kind": "essay"}))
    assert doc["title"] == "Reading notes: Walking"
    content = json.loads(doc["content_json"])
    types = [n["type"] for n in content["content"]]
    assert types[:4] == ["paragraph", "heading", "paragraph", "heading"]
    assert types.count("blockquote") == 2
    text = doc["plain_text"]
    assert "Summary" in text and "Key quotes" in text and "My response" in text and "First quote." in text
    note = content["content"][4]["content"][0]["content"][1]
    assert note == {"type": "footnote", "attrs": {"text": "Thoreau, “Walking”, 1862, p. 4", "sourceId": c1["source_id"]}}
    assert len(api.ok(api.c.get(f"/api/documents/{doc['id']}/clips"))) == 2
    assert api.c.post(f"/api/sources/{c1['source_id']}/reading-notes", json={"kind": "diary"}).status_code == 400


def test_export_carries_citations_through(api):
    c = clip(api, "In wildness is the preservation of the world.", title="Walking", author="Thoreau", published="1862",
             url="https://example.org/walking")
    sid = c["source_id"]
    doc = {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "As Thoreau put it"},
        {"type": "footnote", "attrs": {"text": "", "sourceId": sid}},
        {"type": "text", "text": ", and later "},
        {"type": "text", "text": "(Thoreau 1862, p. 4)", "marks": [{"type": "citation", "attrs": {"sourceId": sid, "locator": "4"}}]},
        {"type": "text", "text": "."},
    ]}]}
    d = api.ok(api.c.post("/api/documents", json={"kind": "essay", "title": "Wildness", "content_json": json.dumps(doc)}))
    md = api.c.get(f"/api/documents/{d['id']}/export?format=md").text
    assert "As Thoreau put it[^1], and later (Thoreau 1862, p. 4)." in md
    assert "## Sources\n\n- Thoreau, “Walking”, 1862, https://example.org/walking" in md
    assert "[^1]: Thoreau, “Walking”, 1862, https://example.org/walking" in md
    html = api.c.get(f"/api/documents/{d['id']}/export?format=html").text
    assert "<cite>(Thoreau 1862, p. 4)</cite>" in html and "<h2>Sources</h2>" in html
    raw = api.c.get(f"/api/documents/{d['id']}/export?format=docx").content
    z = zipfile.ZipFile(io.BytesIO(raw))
    assert "Thoreau, “Walking”, 1862" in z.read("word/footnotes.xml").decode()
    assert "Sources" in z.read("word/document.xml").decode()


def test_full_backup_includes_research(api):
    clip(api, "q", title="S")
    z = zipfile.ZipFile(io.BytesIO(api.c.get("/api/export/full").content))
    data = json.loads(z.read("data.json"))
    assert data["sources"][0]["title"] == "S" and data["clips"][0]["quote"] == "q"

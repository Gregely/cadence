from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from cadence import clock
from cadence.app import create_app


@pytest.fixture(autouse=True)
def _reset_clock():
    clock.reset()
    yield
    clock.reset()


@pytest.fixture
def db_path(tmp_path):
    return tmp_path / "cadence.sqlite3"


@pytest.fixture
def client(db_path, tmp_path):
    app = create_app(db_path, static_dir=tmp_path / "no-static")
    with TestClient(app) as c:
        yield c


def doc_json(*paragraphs: str) -> str:
    return json.dumps(
        {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": p}]} if p else {"type": "paragraph"}
                for p in paragraphs
            ],
        }
    )


class Api:
    """Small helpers so tests read as intent rather than HTTP plumbing."""

    def __init__(self, client: TestClient):
        self.c = client

    def ok(self, resp, status=(200, 201, 204)):
        assert resp.status_code in (status if isinstance(status, tuple) else (status,)), resp.text
        return resp.json() if resp.content else None

    def folder(self, kind, name, parent_id=None, index=None):
        return self.ok(self.c.post("/api/folders", json={"kind": kind, "name": name, "parent_id": parent_id, "index": index}))

    def doc(self, kind, title="", text=None, folder_id=None, **extra):
        body = {"kind": kind, "title": title, "folder_id": folder_id, **extra}
        if text is not None:
            body["content_json"] = doc_json(text)
        return self.ok(self.c.post("/api/documents", json=body))

    def tree(self, kind):
        return self.ok(self.c.get(f"/api/kinds/{kind}/tree"))

    def order(self, kind, folder_id=None):
        t = self.tree(kind)
        return [d["title"] for d in sorted(
            (d for d in t["documents"] if d["folder_id"] == folder_id), key=lambda d: d["sort_order"])]

    def folder_order(self, kind, parent_id=None):
        t = self.tree(kind)
        return [f["name"] for f in sorted(
            (f for f in t["folders"] if f["parent_id"] == parent_id), key=lambda f: f["sort_order"])]

    def search(self, q, kind=None, all_kinds=False):
        params = {"q": q}
        if kind:
            params["kind"] = kind
        if all_kinds:
            params["all_kinds"] = "true"
        return self.ok(self.c.get("/api/search", params=params))


@pytest.fixture
def api(client):
    return Api(client)


@pytest.fixture
def diary(api):
    """A diary with a passphrase set; returns a helper to add entries."""
    from tests.crypto_helpers import envelope, vault_payload

    api.ok(api.c.post("/api/vaults/diary", json=vault_payload()))

    def add(text: str) -> dict:
        return api.ok(api.c.post("/api/documents", json={"kind": "diary", "content_json": envelope(text)}))

    return add

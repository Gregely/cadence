"""Static files are served with the right Content-Type whatever the OS says.

On Windows, Python's mimetypes reads the registry; on some machines .js is
registered as text/plain, and the browser then refuses to run the app's
module script (a blank page). These tests simulate that registry.
"""

from __future__ import annotations

import mimetypes
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cadence.app import create_app

ROOT = Path(__file__).resolve().parent.parent
BUILT = ROOT / "frontend" / "dist"

# What a badly configured Windows registry can say.
BAD_REGISTRY = {
    ".js": "text/plain",
    ".mjs": "text/plain",
    ".css": "text/plain",
    ".json": "text/plain",
    ".svg": "text/plain",
    ".webmanifest": "text/plain",
    ".woff2": "application/octet-stream",
}

EXPECTED = {
    "assets/app-1a2b.js": "text/javascript",
    "assets/chunk-3c4d.mjs": "text/javascript",
    "assets/app-1a2b.css": "text/css",
    "assets/data.json": "application/json",
    "manifest.webmanifest": "application/manifest+json",
    "sw.js": "text/javascript",
    "icons/icon.svg": "image/svg+xml",
    "icons/icon-192.png": "image/png",
    "assets/font-5e6f.woff2": "font/woff2",
    "favicon.ico": "image/x-icon",
    "index.html": "text/html",
}


@pytest.fixture
def bad_registry(monkeypatch):
    """Make mimetypes behave like a Windows machine with a broken registry.

    Setting types_map['.js'] alone is not enough: clearing the initialised
    state makes mimetypes rebuild its tables on next use (which is when it
    reads the registry on Windows), so the bad entries are applied inside
    init() as well, exactly where the registry would apply them.
    """
    for name in ("inited", "_db", "types_map", "encodings_map", "suffix_map", "common_types", "init"):
        monkeypatch.setattr(mimetypes, name, getattr(mimetypes, name))
    real_init = mimetypes.init

    def init_with_bad_registry(files=None):
        real_init(files)
        for ext, media in BAD_REGISTRY.items():
            mimetypes._db.add_type(media, ext)  # what the registry read does on Windows
        mimetypes.types_map.update(BAD_REGISTRY)

    mimetypes.types_map[".js"] = "text/plain"
    monkeypatch.setattr(mimetypes, "inited", False)
    monkeypatch.setattr(mimetypes, "_db", None)
    monkeypatch.setattr(mimetypes, "init", init_with_bad_registry)
    # The simulation must actually be in effect before the app starts.
    assert mimetypes.guess_type("bundle.js")[0] == "text/plain"
    assert mimetypes.guess_type("style.css")[0] == "text/plain"


def make_dist(root: Path) -> Path:
    for rel in EXPECTED:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"<!doctype html><title>Cadence</title>" if rel == "index.html" else b"x")
    return root


def client_for(tmp_path: Path, static: Path) -> TestClient:
    return TestClient(create_app(tmp_path / "db.sqlite3", static_dir=static))


def content_type(resp) -> str:
    return resp.headers["content-type"].split(";")[0].strip()


@pytest.mark.parametrize("bad", [False, True], ids=["os-defaults", "bad-registry"])
def test_static_types(tmp_path, request, bad):
    if bad:
        request.getfixturevalue("bad_registry")
    dist = make_dist(tmp_path / "dist")
    with client_for(tmp_path, dist) as c:
        for rel, expected in EXPECTED.items():
            r = c.get("/" + rel)
            assert r.status_code == 200, rel
            assert content_type(r) == expected, f"{rel}: {r.headers['content-type']}"
        # Client-side routes fall back to index.html as HTML.
        assert content_type(c.get("/d/12")) == "text/html"
        assert content_type(c.head("/sw.js")) == "text/javascript"


@pytest.mark.skipif(not (BUILT / "index.html").is_file(), reason="frontend not built (npm run build)")
@pytest.mark.parametrize("bad", [False, True], ids=["os-defaults", "bad-registry"])
def test_built_app_assets(tmp_path, request, bad):
    """The real build: the JS bundle, CSS, manifest and service worker."""
    if bad:
        request.getfixturevalue("bad_registry")
    with client_for(tmp_path, BUILT) as c:
        index = c.get("/")
        assert content_type(index) == "text/html"
        scripts = re.findall(r'<script[^>]+src="(/assets/[^"]+\.js)"', index.text)
        styles = re.findall(r'<link[^>]+href="(/assets/[^"]+\.css)"', index.text)
        assert scripts and styles
        for url in scripts:
            assert content_type(c.get(url)) == "text/javascript", url
        for url in styles:
            assert content_type(c.get(url)) == "text/css", url
        assert content_type(c.get("/manifest.webmanifest")) == "application/manifest+json"
        sw = c.get("/sw.js")
        assert sw.status_code == 200 and content_type(sw) == "text/javascript"
        assert content_type(c.get("/icons/icon.svg")) == "image/svg+xml"
        assert content_type(c.get("/icons/icon-192.png")) == "image/png"
        fonts = sorted(BUILT.glob("assets/*.woff2"))
        assert fonts and content_type(c.get(f"/assets/{fonts[0].name}")) == "font/woff2"

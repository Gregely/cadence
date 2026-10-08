"""FastAPI application: JSON API plus the built frontend from one origin."""

from __future__ import annotations

import ipaddress
import mimetypes
import os
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlsplit

from fastapi import Body, Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.background import BackgroundTask

from . import export, fullbackup, library, notebook, research, search, vaults
from .db import connect, default_db_path, open_db
from .errors import CadenceError, Invalid
from .kinds import all_kinds

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_STATIC = ROOT / "frontend" / "dist"

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; "
    "manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; "
    "frame-ancestors 'none'; form-action 'self'"
)

# Content types for the files the web app is built from. Python's mimetypes
# reads the Windows registry, where .js is sometimes registered as text/plain;
# browsers then refuse to run the module script and the page stays blank.
# These are registered over whatever the OS says, and the frontend route also
# looks them up here directly, so the app never depends on the OS setting.
STATIC_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def register_static_types() -> None:
    """Override the OS (registry) mappings for the types the app serves."""
    for ext, media in STATIC_TYPES.items():
        mimetypes.add_type(media, ext)


def static_media_type(path: Path) -> str | None:
    media = STATIC_TYPES.get(path.suffix.lower())
    if media:
        return media
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed


TAILNET = ipaddress.ip_network("100.64.0.0/10")
TAILNET6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")


def host_allowed(host: str, extra: list[str]) -> bool:
    """Guard against DNS rebinding: only answer to names we expect."""
    if not host:
        return False
    if host.startswith("["):
        name = host[1:].split("]", 1)[0]
    else:
        name = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    name = name.lower().rstrip(".")
    if name in ("localhost", "testserver") or name.endswith(".ts.net") or name.endswith(".localhost"):
        return True
    for pattern in extra:
        pattern = pattern.strip().lower()
        if not pattern:
            continue
        if pattern == "*" or name == pattern or (pattern.startswith("*.") and name.endswith(pattern[1:])):
            return True
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        return False
    return ip.is_loopback or ip in TAILNET or ip in TAILNET6 or ip.is_private


def create_app(db_path: str | os.PathLike | None = None, static_dir: str | os.PathLike | None = None) -> FastAPI:
    register_static_types()
    db_path = Path(db_path or default_db_path())
    static = Path(static_dir or os.environ.get("CADENCE_STATIC") or DEFAULT_STATIC)
    extra_hosts = [h for h in os.environ.get("CADENCE_ALLOWED_HOSTS", "").split(",") if h]

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        conn = open_db(db_path)
        try:
            library.purge_expired(conn)
            library.fts_rebuild(conn)
        finally:
            conn.close()
        yield

    app = FastAPI(title="Cadence", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.db_path = db_path

    def get_db() -> Iterator[sqlite3.Connection]:
        conn = connect(db_path)
        try:
            yield conn
        finally:
            conn.close()

    Db = Depends(get_db)

    @app.middleware("http")
    async def guard_and_headers(request: Request, call_next):
        host = request.headers.get("host", "")
        if not host_allowed(host, extra_hosts):
            return JSONResponse({"detail": "unexpected host"}, status_code=421)
        path = request.url.path
        if path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            if origin and urlsplit(origin).netloc.lower() != host.lower():
                return JSONResponse({"detail": "cross-origin request refused"}, status_code=403)
            if request.headers.get("sec-fetch-site") in ("cross-site",):
                return JSONResponse({"detail": "cross-site request refused"}, status_code=403)
            ctype = request.headers.get("content-type", "")
            has_body = request.headers.get("content-length", "0") not in ("", "0")
            if has_body and not ctype.startswith("application/json"):
                return JSONResponse({"detail": "expected application/json"}, status_code=415)
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = CSP
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), interest-cohort=()"
        if path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        elif path.startswith("/assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(CadenceError)
    async def cadence_error(_: Request, exc: CadenceError):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        # Never echo submitted values back (they may be private text).
        errors = [
            {"loc": [str(p) for p in e.get("loc", ())], "msg": e.get("msg", "invalid")} for e in exc.errors()
        ]
        return JSONResponse({"detail": "invalid request", "errors": errors}, status_code=422)

    def body_dict(payload: Any) -> dict:
        if not isinstance(payload, dict):
            raise Invalid("expected a JSON object")
        return payload

    def opt_int(payload: dict, key: str) -> int | None:
        value = payload.get(key)
        if value is None:
            return None
        if not isinstance(value, int) or isinstance(value, bool):
            raise Invalid(f"{key} must be a whole number")
        return value

    # ------------------------------------------------------------ kinds/state

    @app.get("/api/kinds")
    def kinds():
        return [k.to_public() for k in all_kinds()]

    @app.get("/api/state")
    def state(conn: sqlite3.Connection = Db):
        return {"last_document": library.last_opened(conn)}

    @app.get("/api/kinds/{kind_id}/tree")
    def kind_tree(kind_id: str, conn: sqlite3.Connection = Db):
        out = library.tree(conn, kind_id)
        out["last_document_id"] = library.last_opened_in_kind(conn, kind_id)
        return out

    @app.get("/api/kinds/{kind_id}/stream")
    def kind_stream(
        kind_id: str,
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=1, le=200),
        conn: sqlite3.Connection = Db,
    ):
        return library.stream(conn, kind_id, offset, limit)

    # ------------------------------------------------------------ folders

    @app.post("/api/folders", status_code=201)
    def create_folder(payload: Any = Body(...), conn: sqlite3.Connection = Db):
        p = body_dict(payload)
        return library.create_folder(
            conn, p.get("kind", ""), p.get("name", ""), opt_int(p, "parent_id"), opt_int(p, "index")
        )

    @app.patch("/api/folders/{folder_id}")
    def rename_folder(folder_id: int, payload: Any = Body(...), conn: sqlite3.Connection = Db):
        p = body_dict(payload)
        if "kind" in p:
            from .errors import Forbidden

            raise Forbidden("folders cannot move to another kind")
        return library.rename_folder(conn, folder_id, p.get("name", ""))

    @app.post("/api/folders/{folder_id}/move")
    def move_folder(folder_id: int, payload: Any = Body(...), conn: sqlite3.Connection = Db):
        p = body_dict(payload)
        return library.move_folder(conn, folder_id, opt_int(p, "parent_id"), opt_int(p, "index"), p.get("kind"))

    @app.delete("/api/folders/{folder_id}")
    def delete_folder(folder_id: int, conn: sqlite3.Connection = Db):
        return library.delete_folder(conn, folder_id)

    # ------------------------------------------------------------ documents

    @app.post("/api/documents", status_code=201)
    def create_document(payload: Any = Body(...), conn: sqlite3.Connection = Db):
        p = body_dict(payload)
        return library.create_document(
            conn,
            p.get("kind", ""),
            folder_id=opt_int(p, "folder_id"),
            title=p.get("title"),
            content_json=p.get("content_json"),
            plain_text=p.get("plain_text"),
            status=p.get("status"),
            meta=p.get("meta"),
            index=opt_int(p, "index"),
        )

    @app.get("/api/documents/{doc_id}")
    def get_document(doc_id: int, conn: sqlite3.Connection = Db):
        return notebook.full_document(conn, doc_id)

    @app.post("/api/documents/{doc_id}/open")
    def open_document(doc_id: int, conn: sqlite3.Connection = Db):
        return library.open_document(conn, doc_id)

    @app.patch("/api/documents/{doc_id}")
    def update_document(doc_id: int, payload: Any = Body(...), conn: sqlite3.Connection = Db):
        return library.update_document(conn, doc_id, body_dict(payload))

    @app.post("/api/documents/{doc_id}/move")
    def move_document(doc_id: int, payload: Any = Body(...), conn: sqlite3.Connection = Db):
        p = body_dict(payload)
        return library.move_document(conn, doc_id, opt_int(p, "folder_id"), opt_int(p, "index"), p.get("kind"))

    @app.delete("/api/documents/{doc_id}")
    def delete_document(doc_id: int, conn: sqlite3.Connection = Db):
        return library.delete_document(conn, doc_id)

    # ------------------------------------------------------------ snapshots

    @app.get("/api/documents/{doc_id}/snapshots")
    def list_snapshots(doc_id: int, conn: sqlite3.Connection = Db):
        return notebook.list_snapshots(conn, doc_id)

    @app.post("/api/documents/{doc_id}/snapshots", status_code=201)
    def create_snapshot(doc_id: int, payload: Any = Body(default={}), conn: sqlite3.Connection = Db):
        p = body_dict(payload or {})
        return notebook.create_snapshot(conn, doc_id, p.get("label"), p.get("content_json"))

    @app.get("/api/snapshots/{snap_id}")
    def get_snapshot(snap_id: int, conn: sqlite3.Connection = Db):
        return notebook.get_snapshot(conn, snap_id)

    @app.patch("/api/snapshots/{snap_id}")
    def rename_snapshot(snap_id: int, payload: Any = Body(...), conn: sqlite3.Connection = Db):
        return notebook.rename_snapshot(conn, snap_id, body_dict(payload).get("label", ""))

    @app.delete("/api/snapshots/{snap_id}", status_code=204)
    def delete_snapshot(snap_id: int, conn: sqlite3.Connection = Db):
        notebook.delete_snapshot(conn, snap_id)
        return Response(status_code=204)

    @app.post("/api/snapshots/{snap_id}/restore")
    def restore_snapshot(snap_id: int, conn: sqlite3.Connection = Db):
        return notebook.restore_snapshot(conn, snap_id)

    # ------------------------------------------------------------ inbox

    @app.post("/api/inbox", status_code=201)
    def capture(payload: Any = Body(...), conn: sqlite3.Connection = Db):
        p = body_dict(payload)
        return notebook.capture(conn, p.get("text"), p.get("from_kind"))

    @app.get("/api/inbox")
    def inbox(include_handled: bool = False, conn: sqlite3.Connection = Db):
        return notebook.list_inbox(conn, include_handled)

    @app.patch("/api/inbox/{item_id}")
    def update_inbox(item_id: int, payload: Any = Body(...), conn: sqlite3.Connection = Db):
        p = body_dict(payload)
        result = None
        if "text" in p:
            result = notebook.edit_inbox(conn, item_id, p["text"])
        if "handled" in p:
            result = notebook.set_handled(conn, item_id, bool(p["handled"]))
        if result is None:
            raise Invalid("nothing to change")
        return result

    @app.delete("/api/inbox/{item_id}", status_code=204)
    def delete_inbox(item_id: int, conn: sqlite3.Connection = Db):
        notebook.delete_inbox(conn, item_id)
        return Response(status_code=204)

    @app.post("/api/inbox/{item_id}/to-document")
    def inbox_to_document(item_id: int, payload: Any = Body(...), conn: sqlite3.Connection = Db):
        p = body_dict(payload)
        return notebook.inbox_to_document(
            conn, item_id, p.get("kind", ""), opt_int(p, "folder_id"), opt_int(p, "document_id")
        )

    # ------------------------------------------------------------ sessions

    @app.post("/api/sessions", status_code=201)
    def start_session(payload: Any = Body(...), conn: sqlite3.Connection = Db):
        p = body_dict(payload)
        doc_id = opt_int(p, "document_id")
        if doc_id is None:
            raise Invalid("document_id is required")
        return notebook.start_session(conn, doc_id, p.get("words_start"))

    @app.post("/api/sessions/{session_id}/checkpoint")
    def checkpoint(session_id: int, payload: Any = Body(...), conn: sqlite3.Connection = Db):
        return notebook.add_checkpoint(conn, session_id, body_dict(payload).get("feeling"))

    @app.post("/api/sessions/{session_id}/end")
    def end_session(session_id: int, payload: Any = Body(default={}), conn: sqlite3.Connection = Db):
        p = body_dict(payload or {})
        return notebook.end_session(conn, session_id, p.get("words_end"), p.get("reentry_note"))

    @app.get("/api/documents/{doc_id}/sessions")
    def sessions(doc_id: int, conn: sqlite3.Connection = Db):
        return notebook.list_sessions(conn, doc_id)

    # ------------------------------------------------------------ trash

    @app.get("/api/trash")
    def trash(kind: str | None = None, conn: sqlite3.Connection = Db):
        library.purge_expired(conn)
        return library.trash(conn, kind)

    @app.post("/api/trash/documents/{doc_id}/restore")
    def restore_document(doc_id: int, conn: sqlite3.Connection = Db):
        return library.restore_document(conn, doc_id)

    @app.post("/api/trash/folders/{folder_id}/restore")
    def restore_folder(folder_id: int, conn: sqlite3.Connection = Db):
        return library.restore_folder(conn, folder_id)

    @app.delete("/api/trash/documents/{doc_id}", status_code=204)
    def purge_document(doc_id: int, conn: sqlite3.Connection = Db):
        library.purge_document(conn, doc_id)
        return Response(status_code=204)

    @app.delete("/api/trash/folders/{folder_id}", status_code=204)
    def purge_folder(folder_id: int, conn: sqlite3.Connection = Db):
        library.purge_folder(conn, folder_id)
        return Response(status_code=204)

    # ------------------------------------------------------------ search

    @app.get("/api/search")
    def do_search(
        q: str = "",
        kind: str | None = None,
        all_kinds: bool = False,
        limit: int = Query(30, ge=1, le=100),
        conn: sqlite3.Connection = Db,
    ):
        return search.search(conn, q, kind_id=kind, all_kinds=all_kinds, limit=limit)

    # ------------------------------------------------------------ vaults (encrypted kinds)

    @app.get("/api/vaults/{kind_id}")
    def get_vault(kind_id: str, conn: sqlite3.Connection = Db):
        return {"vault": vaults.get_vault(conn, kind_id)}

    @app.post("/api/vaults/{kind_id}", status_code=201)
    def create_vault(kind_id: str, payload: Any = Body(...), conn: sqlite3.Connection = Db):
        return vaults.create_vault(conn, kind_id, payload)

    @app.get("/api/vaults/{kind_id}/items")
    def vault_items(kind_id: str, conn: sqlite3.Connection = Db):
        return vaults.encrypted_items(conn, kind_id)

    @app.post("/api/vaults/{kind_id}/rekey")
    def rekey_vault(kind_id: str, payload: Any = Body(...), conn: sqlite3.Connection = Db):
        return vaults.rekey(conn, kind_id, payload)

    # ------------------------------------------------------------ research

    @app.get("/api/sources")
    def list_sources(q: str = "", conn: sqlite3.Connection = Db):
        return research.list_sources(conn, q)

    @app.post("/api/sources", status_code=201)
    def create_source(payload: Any = Body(...), conn: sqlite3.Connection = Db):
        return research.create_source(conn, payload)

    @app.get("/api/sources/{source_id}")
    def get_source(source_id: int, conn: sqlite3.Connection = Db):
        return research.get_source(conn, source_id)

    @app.patch("/api/sources/{source_id}")
    def update_source(source_id: int, payload: Any = Body(...), conn: sqlite3.Connection = Db):
        return research.update_source(conn, source_id, payload)

    @app.delete("/api/sources/{source_id}", status_code=204)
    def delete_source(source_id: int, conn: sqlite3.Connection = Db):
        research.delete_source(conn, source_id)
        return Response(status_code=204)

    @app.post("/api/sources/{source_id}/reading-notes", status_code=201)
    def reading_notes(source_id: int, payload: Any = Body(...), conn: sqlite3.Connection = Db):
        p = body_dict(payload)
        return research.reading_notes(conn, source_id, p.get("kind", ""), opt_int(p, "folder_id"))

    @app.post("/api/clips", status_code=201)
    def create_clip(payload: Any = Body(...), conn: sqlite3.Connection = Db):
        return research.clip(conn, payload)

    @app.patch("/api/clips/{clip_id}")
    def update_clip(clip_id: int, payload: Any = Body(...), conn: sqlite3.Connection = Db):
        return research.update_clip(conn, clip_id, payload)

    @app.delete("/api/clips/{clip_id}", status_code=204)
    def delete_clip(clip_id: int, conn: sqlite3.Connection = Db):
        research.delete_clip(conn, clip_id)
        return Response(status_code=204)

    @app.post("/api/clips/{clip_id}/documents/{doc_id}")
    def attach_clip(clip_id: int, doc_id: int, conn: sqlite3.Connection = Db):
        return research.attach(conn, clip_id, doc_id, True)

    @app.delete("/api/clips/{clip_id}/documents/{doc_id}")
    def detach_clip(clip_id: int, doc_id: int, conn: sqlite3.Connection = Db):
        return research.attach(conn, clip_id, doc_id, False)

    @app.get("/api/documents/{doc_id}/clips")
    def document_clips(doc_id: int, conn: sqlite3.Connection = Db):
        return research.document_clips(conn, doc_id)

    @app.get("/api/research/search")
    def research_search(q: str = "", conn: sqlite3.Connection = Db):
        return research.research_search(conn, q)

    @app.get("/api/research/preview/{doc_id}")
    def research_preview(doc_id: int, conn: sqlite3.Connection = Db):
        return research.preview(conn, doc_id)

    # ------------------------------------------------------------ export

    def download(exp: export.Export, fmt: str) -> Response:
        body, media, filename = export.render(exp, fmt)
        return Response(body, media_type=media, headers={"Content-Disposition": export.content_disposition(filename)})

    @app.get("/api/documents/{doc_id}/export")
    def export_document(doc_id: int, format: str = "md", conn: sqlite3.Connection = Db):
        return download(export.document_export(conn, doc_id), format)

    @app.get("/api/folders/{folder_id}/export")
    def export_folder(folder_id: int, format: str = "md", conn: sqlite3.Connection = Db):
        return download(export.folder_export(conn, folder_id), format)

    @app.get("/api/export/full")
    def export_full(conn: sqlite3.Connection = Db):
        path = fullbackup.build(db_path, conn)
        from . import clock as _clock

        name = f"cadence-backup-{_clock.iso()[:10]}.zip"
        return FileResponse(
            path,
            media_type="application/zip",
            headers={"Content-Disposition": export.content_disposition(name)},
            background=BackgroundTask(lambda: path.unlink(missing_ok=True)),
        )

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"])
    def api_not_found(rest: str):
        return JSONResponse({"detail": "not found"}, status_code=404)

    # ------------------------------------------------------------ frontend

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def frontend(path: str):
        index = static / "index.html"
        if path:
            candidate = (static / path).resolve()
            try:
                candidate.relative_to(static.resolve())
            except ValueError:
                return JSONResponse({"detail": "not found"}, status_code=404)
            if candidate.is_file():
                return FileResponse(candidate, media_type=static_media_type(candidate))
            if path.startswith("assets/"):
                return JSONResponse({"detail": "not found"}, status_code=404)
        if index.is_file():
            return FileResponse(index, media_type=STATIC_TYPES[".html"])
        return JSONResponse(
            {"detail": "frontend not built: run `npm run build` in frontend/"}, status_code=503
        )

    return app

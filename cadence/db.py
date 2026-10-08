"""SQLite connection handling and the migration runner."""

from __future__ import annotations

import importlib.util
import os
import re
import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
# SQL files, or Python files defining ``upgrade(conn)`` for steps that need
# the kinds registry. Each runs once, in order, in its own transaction.
MIGRATION_NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.(sql|py)$")

DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "cadence.sqlite3"


def default_db_path() -> Path:
    return Path(os.environ.get("CADENCE_DB") or DEFAULT_DB)


def connect(path: str | os.PathLike) -> sqlite3.Connection:
    # check_same_thread=False: FastAPI may run a request's dependency and endpoint
    # on different worker threads; each connection still serves one request.
    conn = sqlite3.connect(path, timeout=10, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    # Overwrite deleted content with zeros so purged text does not linger in
    # free pages of the database file or its backups.
    conn.execute("PRAGMA secure_delete = ON")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def open_db(path: str | os.PathLike) -> sqlite3.Connection:
    """Open (creating if needed) a database in WAL mode and migrate it."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = connect(path)
    mode = conn.execute("PRAGMA journal_mode = WAL").fetchone()[0]
    if mode.lower() != "wal":
        raise RuntimeError(f"could not enable WAL mode (got {mode})")
    migrate(conn)
    return conn


def available_migrations() -> list[tuple[int, Path]]:
    found = []
    for p in sorted(MIGRATIONS_DIR.iterdir()):
        m = MIGRATION_NAME.match(p.name)
        if m:
            found.append((int(m.group(1)), p))
    versions = [v for v, _ in found]
    if len(set(versions)) != len(versions):
        raise RuntimeError("duplicate migration version numbers")
    return found


def applied_versions(conn: sqlite3.Connection) -> set[int]:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        " version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
    )
    return {r[0] for r in conn.execute("SELECT version FROM schema_migrations")}


def migrate(conn: sqlite3.Connection) -> list[int]:
    """Apply pending migrations in order, each in its own transaction."""
    done = applied_versions(conn)
    applied = []
    for version, path in available_migrations():
        if version in done:
            continue
        try:
            conn.execute("BEGIN IMMEDIATE")
            if path.suffix == ".py":
                _python_migration(path)(conn)
            else:
                for statement in split_sql(path.read_text(encoding="utf-8")):
                    conn.execute(statement)
            conn.execute(
                "INSERT INTO schema_migrations (version, name, applied_at)"
                " VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                (version, path.name),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        applied.append(version)
    return applied


def _python_migration(path: Path):
    spec = importlib.util.spec_from_file_location(f"cadence_migration_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load migration {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    upgrade = getattr(module, "upgrade", None)
    if not callable(upgrade):
        raise RuntimeError(f"migration {path.name} has no upgrade(conn)")
    return upgrade


def split_sql(sql: str) -> list[str]:
    """Split a migration file into statements (handles triggers' BEGIN/END)."""
    statements, buf = [], []
    for line in sql.splitlines():
        stripped = line.strip()
        if stripped.startswith("--") or not stripped:
            continue
        buf.append(line)
        candidate = "\n".join(buf)
        if stripped.endswith(";") and sqlite3.complete_statement(candidate):
            statements.append(candidate)
            buf = []
    if "".join(buf).strip():
        statements.append("\n".join(buf))
    return statements

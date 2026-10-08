import os
import sqlite3
import subprocess
import sys
import threading
from datetime import datetime, timedelta
from pathlib import Path

from cadence.backup import backup, main
from cadence.db import open_db

ROOT = Path(__file__).resolve().parent.parent


def test_backup_while_app_is_writing(api, db_path, tmp_path):
    for i in range(20):
        api.doc("essay", f"doc {i}", f"text {i}")
    stop = threading.Event()

    def writer():
        conn = open_db(db_path)
        n = 0
        while not stop.is_set():
            conn.execute(
                "INSERT INTO inbox (text, created_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))", (f"w{n}",)
            )
            n += 1
        conn.close()

    t = threading.Thread(target=writer)
    t.start()
    try:
        out = backup(db_path, tmp_path / "backups", keep=30)
    finally:
        stop.set()
        t.join()
    assert out.name.startswith("cadence-") and out.suffix == ".sqlite3"
    conn = sqlite3.connect(out)
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert conn.execute("select count(*) from documents").fetchone()[0] == 20
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    assert not Path(str(out) + "-wal").exists()


def test_backup_keeps_newest_30(db_path, tmp_path):
    open_db(db_path).close()
    dest = tmp_path / "b"
    start = datetime(2026, 1, 1, 3, 0, 0)
    for i in range(35):
        backup(db_path, dest, keep=30, now=start + timedelta(days=i))
    names = sorted(p.name for p in dest.iterdir())
    assert len(names) == 30
    assert names[0] == "cadence-20260106-030000.sqlite3"
    assert names[-1] == "cadence-20260204-030000.sqlite3"
    # Unrelated files are never pruned.
    (dest / "notes.txt").write_text("keep me")
    backup(db_path, dest, keep=30, now=start + timedelta(days=40))
    assert (dest / "notes.txt").exists()


def test_backup_same_second_does_not_overwrite(db_path, tmp_path):
    open_db(db_path).close()
    when = datetime(2026, 5, 5, 5, 5, 5)
    a = backup(db_path, tmp_path / "b", now=when)
    b = backup(db_path, tmp_path / "b", now=when)
    assert a != b and a.exists() and b.exists()


def test_backup_exits_nonzero_on_failure(tmp_path, capsys):
    code = main(["--db", str(tmp_path / "missing.sqlite3"), "--dest", str(tmp_path / "b")])
    assert code == 1
    assert "FAILED" in capsys.readouterr().err
    assert not (tmp_path / "missing.sqlite3").exists()


def test_backup_exits_nonzero_on_corrupt_db(tmp_path):
    bad = tmp_path / "bad.sqlite3"
    bad.write_bytes(b"this is not a database" * 100)
    assert main(["--db", str(bad), "--dest", str(tmp_path / "b")]) == 1


def test_backup_cli_module(db_path, tmp_path):
    open_db(db_path).close()
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    r = subprocess.run(
        [sys.executable, "-m", "cadence.backup", "--db", str(db_path), "--dest", str(tmp_path / "cli")],
        capture_output=True, text=True, env=env, cwd=ROOT,
    )
    assert r.returncode == 0, r.stderr
    assert len(list((tmp_path / "cli").glob("cadence-*.sqlite3"))) == 1
    r = subprocess.run(
        [sys.executable, "-m", "cadence.backup", "--db", str(tmp_path / "nope.sqlite3"), "--dest", str(tmp_path / "cli")],
        capture_output=True, text=True, env=env, cwd=ROOT,
    )
    assert r.returncode == 1

import sqlite3

from cadence.db import available_migrations, migrate, open_db, split_sql


def test_migrations_apply_once_and_wal(db_path):
    conn = open_db(db_path)
    versions = [v for v, _ in available_migrations()]
    assert sorted(r[0] for r in conn.execute("select version from schema_migrations")) == versions
    assert migrate(conn) == []
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    tables = {r[0] for r in conn.execute("select name from sqlite_master")}
    assert {"folders", "documents", "snapshots", "inbox", "sessions", "documents_fts"} <= tables


def test_split_sql_handles_triggers():
    sql = """
    -- comment
    CREATE TABLE t (x);
    CREATE TRIGGER tr AFTER INSERT ON t BEGIN
        UPDATE t SET x = 1;
    END;
    """
    assert len(split_sql(sql)) == 2


def test_failed_migration_rolls_back(tmp_path, monkeypatch):
    import cadence.db as db

    mig = tmp_path / "migs"
    mig.mkdir()
    (mig / "0001_ok.sql").write_text("CREATE TABLE a (x);")
    (mig / "0002_bad.sql").write_text("CREATE TABLE b (x);\nTHIS IS NOT SQL;")
    monkeypatch.setattr(db, "MIGRATIONS_DIR", mig)
    conn = db.connect(tmp_path / "x.sqlite3")
    try:
        migrate(conn)
    except sqlite3.Error:
        pass
    tables = {r[0] for r in conn.execute("select name from sqlite_master")}
    assert "a" in tables and "b" not in tables
    assert [r[0] for r in conn.execute("select version from schema_migrations")] == [1]

-- Folders: nested within one kind, at most four deep (enforced in code).
CREATE TABLE folders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT    NOT NULL,
    parent_id   INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    name        TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE INDEX folders_by_parent ON folders(kind, parent_id, sort_order);

CREATE TABLE documents (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT    NOT NULL,
    folder_id       INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    title           TEXT    NOT NULL DEFAULT '',
    content_json    TEXT    NOT NULL,
    plain_text      TEXT    NOT NULL DEFAULT '',
    status          TEXT,
    meta_json       TEXT    NOT NULL DEFAULT '{}',
    deleted_at      TEXT,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    last_opened_at  TEXT
);
CREATE INDEX documents_by_folder ON documents(kind, folder_id, sort_order);
CREATE INDEX documents_by_opened ON documents(last_opened_at);
CREATE INDEX documents_by_deleted ON documents(deleted_at);

CREATE TABLE snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    label         TEXT    NOT NULL,
    content_json  TEXT    NOT NULL,
    created_at    TEXT    NOT NULL
);
CREATE INDEX snapshots_by_document ON snapshots(document_id, created_at);

CREATE TABLE inbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT NOT NULL,
    from_kind   TEXT,
    created_at  TEXT NOT NULL,
    handled_at  TEXT
);

CREATE TABLE sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id       INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    started_at        TEXT    NOT NULL,
    ended_at          TEXT,
    words_start       INTEGER,
    words_end         INTEGER,
    reentry_note      TEXT,
    checkpoints_json  TEXT    NOT NULL DEFAULT '[]'
);
CREATE INDEX sessions_by_document ON sessions(document_id, ended_at);

-- Full-text index over title and plain_text. Maintained by the application
-- (rowid = documents.id) so it can honour each kind's `searchable` flag and
-- leave trashed documents out.
CREATE VIRTUAL TABLE documents_fts USING fts5(
    title, plain_text, tokenize = 'unicode61 remove_diacritics 2'
);

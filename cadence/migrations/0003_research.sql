-- Research: sources, clipped quotes, and which documents use which clips.
CREATE TABLE sources (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    author      TEXT NOT NULL DEFAULT '',
    url         TEXT NOT NULL DEFAULT '',
    published   TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX sources_by_title ON sources(title COLLATE NOCASE);

CREATE TABLE clips (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    quote       TEXT NOT NULL,
    page        TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);
CREATE INDEX clips_by_source ON clips(source_id);

CREATE TABLE clip_documents (
    clip_id      INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (clip_id, document_id)
);
CREATE INDEX clip_documents_by_document ON clip_documents(document_id);

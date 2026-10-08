-- Draft sets: a named copy of every document in a project at one moment.
-- Items keep the document id without a foreign key, so a set still holds a
-- scene's text after the scene itself has been deleted.
CREATE TABLE draft_sets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id   INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    automatic   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL
);
CREATE INDEX draft_sets_by_folder ON draft_sets(folder_id, created_at);

CREATE TABLE draft_set_items (
    set_id        INTEGER NOT NULL REFERENCES draft_sets(id) ON DELETE CASCADE,
    document_id   INTEGER NOT NULL,
    folder_id     INTEGER,
    sort_order    INTEGER NOT NULL,
    title         TEXT    NOT NULL,
    role          TEXT,
    content_json  TEXT    NOT NULL,
    plain_text    TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (set_id, document_id)
);

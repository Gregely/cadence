-- One vault per encrypted kind. The server keeps only what the browser
-- needs to derive the key again (salt, iterations) and a check value
-- encrypted with that key; never the key or the passphrase.
CREATE TABLE vaults (
    kind            TEXT PRIMARY KEY,
    kdf             TEXT    NOT NULL,
    iterations      INTEGER NOT NULL,
    salt            TEXT    NOT NULL,
    check_envelope  TEXT    NOT NULL,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);

# Diary encryption and the plaintext-leak review

## How the diary is encrypted

- The passphrase never leaves the browser. A key is derived from it with
  **PBKDF2-SHA256, 600,000 iterations** and a random 16-byte salt (WebCrypto),
  as a **non-extractable AES-GCM-256** key kept only in a JavaScript variable.
- Each save encrypts `{"doc": <editor JSON>}` with a fresh random 96-bit IV and
  additional data `cadence:v1`. The server stores
  `{"v":1,"alg":"AES-GCM","iv":…,"ct":…}` and nothing else.
- The server keeps a `vaults` row per encrypted kind: salt, iteration count and
  a check value encrypted with the key, so a wrong passphrase is detected
  without the server learning anything.
- Auto-lock after 5 minutes without keyboard, pointer or touch activity
  (configurable). Locking saves pending edits, drops the key, destroys the
  editor (and its undo history) and removes any open panels.
- Changing the passphrase re-encrypts every entry and snapshot (trash included)
  in one transaction; the server refuses a partial set.
- Argon2id was not used: it needs a WebAssembly library, and PBKDF2 is built
  into every browser including the Boox's. The iteration count is stored per
  vault so it can be raised later.

## What the server refuses for encrypted kinds

- `plain_text` (on create and update), any `content_json` that is not exactly
  an envelope (extra fields such as a "preview" are refused), titles (they are
  generated: `Entry 2026-10-08`), statuses, word targets, any `meta` other than
  the cursor position, folders, sessions and re-entry notes, capture into the
  inbox, conversion of inbox items into diary entries, server-side export, and
  snapshot names.
- Entries cannot be created until a passphrase has been set.

## Leak review (Stage 4 self-review)

| Where plaintext could leak | Finding | Status |
|---|---|---|
| Server logs | Access logs are off; error responses and tracebacks never include request bodies. | OK |
| Error messages | FastAPI's validation errors echo the submitted input. | **Fixed**: custom handler drops `input`; app errors no longer repeat submitted values (status, node types, field names, kind ids). Tested. |
| Search index | FTS rows are written by the app only for searchable, non-encrypted kinds; rebuilt from the registry at start-up. | OK, tested |
| Inbox / inbox review | Capture tagged with the diary is refused; review hides any such row even if planted in the database. | OK, tested |
| Snapshot names | Names are stored unencrypted, so naming a diary snapshot would leak. | **Fixed**: diary snapshots get dated names only; renaming is refused; the UI does not ask. Tested. |
| Re-entry notes, sessions | Plain-text notes and word counts. | Refused for encrypted kinds. |
| Backups (`cadence.backup`) | Only ciphertext is ever written; `secure_delete` zeroes freed pages. | OK, tested by scanning backup, database and WAL bytes |
| Full-backup zip | SQLite copy and `data.json` hold ciphertext; diary is left out of the Markdown files. | OK, tested |
| Server exports | Refused for the diary. The decrypted export is made in the browser as a Blob. | OK |
| Browser storage | Unsaved edits are kept in localStorage as the exact request body, i.e. ciphertext. Settings hold no content. The service worker caches static files only, never `/api`. API responses are `no-store`. | OK, tested by scanning localStorage, sessionStorage, IndexedDB and Cache Storage |
| Conflict copies | Saved as snapshots of the ciphertext the client tried to write. | OK |
| Spell checking | Some browsers can send text to a cloud spell checker. | Spellcheck/autocorrect are off in the diary editor. |
| Tab title, history, URLs | Titles are generic; URLs carry only ids. | OK |
| Back/forward cache | A restored page still holds the key. | **Fixed**: the auto-lock check runs on `pageshow`. |
| Passphrase form | Inputs have no `name`, so even a failed script could not submit them. | OK |
| Outbound requests | CSP `connect-src 'self'`, `img-src 'self' data: blob:`; no third-party code at run time. | OK, smoke test fails on any off-origin request |

## Known limits

- Metadata is visible to the server: how many entries exist, when each was
  created and edited, and roughly how long each is (ciphertext length).
- JavaScript cannot wipe memory: decrypted strings may linger until garbage
  collection after locking.
- Anyone who can reach the server (your tailnet) can download the ciphertext
  and try passphrases offline; a long passphrase is the defence.
- A decrypted export is a plain-text file wherever you save it.
- Password managers may offer to store the passphrase; that is your choice.

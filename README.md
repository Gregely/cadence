# Cadence

A calm writing notebook for one person. It opens straight to the last thing
you were writing, with the cursor where you left it. Essays, notes, poetry,
fiction and an encrypted diary each get their own typography and tools;
folders, snapshots, export and research are there when you want them and out
of the way when you don't.

- One process: FastAPI serves the API and the built web app from one origin.
- One file: SQLite in WAL mode, with full-text search (FTS5).
- No accounts, no AI, no analytics, and no network requests leave the app
  (enforced by its Content-Security-Policy). Put it behind Tailscale.
- Installable as a PWA. Paper, dark and high-contrast e-ink themes. No animations.

---

## Contents

1. [Run it on Windows (PowerShell 5.1)](#run-it-on-windows-powershell-51)
2. [Run it on Linux or a Raspberry Pi](#run-it-on-linux-or-a-raspberry-pi)
3. [Reach it over Tailscale with HTTPS](#reach-it-over-tailscale-with-https)
4. [Backups](#backups)
5. [Docker](#docker)
6. [Tests](#tests)
7. [Developing](#developing)
8. [Using Cadence](#using-cadence)
9. [Configuration](#configuration)
10. [Troubleshooting](#troubleshooting)
11. [Adding a kind](#adding-a-kind)
12. [Design decisions](#design-decisions)

---

## Run it on Windows (PowerShell 5.1)

You need **Python 3.11 or newer** and **Node.js 20.19 or newer** (only to build
the web app). Every command below works in Windows PowerShell 5.1 as typed;
none needs administrator rights.

```powershell
cd C:\path\to\cadence

# 1. Python environment and packages
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# 2. Build the web app (once, and after updating)
cd frontend
npm ci
npm run build
cd ..

# 3. Run
.\.venv\Scripts\python.exe -m cadence
```

Open <http://localhost:8765/>. Your writing is stored in `data\cadence.sqlite3`
inside the project folder (change it with `--db` or `CADENCE_DB`).

Options: `.\.venv\Scripts\python.exe -m cadence --help`

```powershell
.\.venv\Scripts\python.exe -m cadence --port 8765 --db D:\Writing\cadence.sqlite3
```

> If `python` opens the Microsoft Store, install Python from python.org and
> tick "Add python.exe to PATH", or use the `py` launcher: `py -3.12 -m venv .venv`.

## Run it on Linux or a Raspberry Pi

Raspberry Pi OS Bookworm ships Python 3.11, which is fine.

```sh
sudo apt install python3-venv
git clone <your copy> cadence && cd cadence
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cd frontend && npm ci && npm run build && cd ..
.venv/bin/python -m cadence
```

Building the web app needs **Node.js 20.19 or newer**; Raspberry Pi OS
Bookworm's own `nodejs` package is version 18, which is too old. Either build
on your Windows machine and copy the `frontend\dist` folder to the Pi (the
server only needs `frontend/dist`, not Node), or install a current Node from
nodejs.org / NodeSource on the Pi.

### Raspberry Pi with systemd

```sh
sudo useradd --system --home /var/lib/cadence --shell /usr/sbin/nologin cadence
sudo mkdir -p /opt/cadence /var/lib/cadence
sudo cp -r cadence requirements.txt /opt/cadence/
sudo mkdir -p /opt/cadence/frontend && sudo cp -r frontend/dist /opt/cadence/frontend/
sudo python3 -m venv /opt/cadence/.venv
sudo /opt/cadence/.venv/bin/python -m pip install -r /opt/cadence/requirements.txt
sudo chown -R cadence:cadence /var/lib/cadence

sudo cp deploy/cadence.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cadence
systemctl status cadence
```

The service listens on `127.0.0.1:8765` only; Tailscale publishes it (next section).

## Reach it over Tailscale with HTTPS

Cadence has no login. It is meant to be reachable only from your own devices,
over your tailnet. HTTPS matters: browsers only allow the diary's encryption,
the service worker and "install app" on secure origins.

1. In the Tailscale admin console, under **DNS**, turn on **MagicDNS** and
   **HTTPS Certificates**.
2. On the machine running Cadence (Pi or Windows), with Cadence running on port 8765:

   ```sh
   tailscale serve --bg 8765
   tailscale serve status
   ```

   This publishes `https://<machine-name>.<your-tailnet>.ts.net/` to your
   tailnet only, with a real certificate, proxying to `http://127.0.0.1:8765`.
   (On Windows run the same commands in PowerShell; `tailscale` is on the PATH
   once Tailscale is installed.)
3. Open that address on your phone, tablet or Boox and use the browser's
   "Install app" / "Add to home screen".

To stop publishing: `tailscale serve reset`. **Do not use `tailscale funnel`**:
that would put Cadence on the public internet.

Cadence also refuses requests whose `Host` is not `localhost`, a `*.ts.net`
name, or a private/Tailscale IP address (protection against DNS rebinding). If
you use another name, list it: `CADENCE_ALLOWED_HOSTS=writing.example.lan`.

## Backups

`python -m cadence.backup` uses SQLite's online backup API, so it is safe while
Cadence is running. It writes `cadence-YYYYMMDD-HHMMSS.sqlite3`, checks the
copy's integrity, keeps the newest 30, and exits non-zero if anything fails.
Encrypted diary entries are in the backup as ciphertext only.

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 -Db D:\Writing\cadence.sqlite3 -Dest D:\cadence-backups -Keep 30
```

```sh
# Linux / Pi
scripts/backup.sh                       # or: .venv/bin/python -m cadence.backup --dest /path/to/backups --keep 30
```

Default destination: `backups/` in the project folder (`CADENCE_BACKUP_DIR` or `--dest` to change).

**Daily on Windows (Task Scheduler)** — register once:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-backup-task.ps1 -At "03:17" -Dest "D:\cadence-backups"
Start-ScheduledTask -TaskName "Cadence backup"      # run it now to check
```

or with `schtasks` (one line; if the path contains spaces, keep the inner quotes as `\"…\"`):

```powershell
schtasks /Create /TN "Cadence backup" /SC DAILY /ST 03:17 /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\cadence\scripts\backup.ps1"
```

**Daily on the Pi (cron)** — `sudo crontab -u cadence -e` and add:

```cron
17 3 * * * cd /opt/cadence && CADENCE_DB=/var/lib/cadence/cadence.sqlite3 .venv/bin/python -m cadence.backup --dest /var/lib/cadence/backups --keep 30 >> /var/lib/cadence/backup.log 2>&1
```

(If you run Cadence from a git checkout instead, use that folder in place of
`/opt/cadence` and drop `CADENCE_DB` if you kept the default.)

Or with systemd: `sudo cp deploy/cadence-backup.* /etc/systemd/system/ && sudo systemctl enable --now cadence-backup.timer`.

Copy the backup folder somewhere else as well (another disk, another machine):
a backup on the same SD card does not survive the SD card.

**Restore:** stop Cadence, copy a backup over the database file (and delete any
`cadence.sqlite3-wal` / `-shm` next to it), start Cadence.

**Full export:** Settings → *Export everything* downloads a zip with a database
copy, all data as JSON, and every exportable document as Markdown.

## Docker

Works on x86-64 and on a 64-bit Raspberry Pi OS.

```sh
docker compose up -d                 # builds the image, keeps data in the "cadence-data" volume
tailscale serve --bg 8765
docker compose exec cadence python -m cadence.backup    # backups land in /data/backups inside the volume
```

The container publishes only to `127.0.0.1:8765` on the host.

## Tests

```powershell
# Backend (pytest)
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest

# Frontend logic (vitest) and type check
cd frontend
npm run typecheck
npm test

# Headless browser smoke test: starts its own server on a temporary database,
# drives the app at desktop and phone size in all three themes, and saves
# screenshots to frontend\test-results. Needs Chrome, Edge or Chromium installed
# (set CADENCE_BROWSER to its path if it is not found).
npm run build
npm run smoke
cd ..
```

On Linux the same commands work with `.venv/bin/python`.

## Developing

Run the API and the Vite dev server side by side (two terminals):

```powershell
.\.venv\Scripts\python.exe -m cadence
cd frontend; npm run dev
```

Vite serves on <http://localhost:5173> and forwards `/api` to port 8765.

## Using Cadence

| Keys | |
|---|---|
| Ctrl+P | Find a document by title (current kind) |
| Ctrl+K, or Alt+1…5 | Switch kind |
| Ctrl+Shift+Space | Capture a thought to the inbox without leaving the page |
| Ctrl+\\ | Show or hide the library |
| Ctrl+Shift+F | Focus mode (Esc leaves) |
| Ctrl+Alt+N | New document |
| Ctrl+S | Save now (saving is automatic anyway) |
| Ctrl+Shift+S | Snapshot |
| Ctrl+. | End the writing session (asks for a one-line note for next time) |
| Ctrl+Shift+E | Research pane (essays) |
| Ctrl+Alt+F | Footnote (essays) |
| `* * *` then space | Section break |
| Library: arrows, Enter, F2, Del | Move, open, rename, trash |
| Library: Alt+Shift+↑↓ / →← | Move up/down, indent/outdent |
| Ctrl+/ | All shortcuts |

- **Formatting** appears as a small floating bar when you select text. There
  are no font, size or colour controls: the kind and theme decide.
- **Poetry:** Enter starts a new line, Enter on a blank line starts a new
  stanza, Tab indents. Lines are never reflowed or justified.
- **Fiction:** a folder is a project; documents inside are numbered, ordered
  scenes or chapters. Export a folder as one manuscript from its ⋯ menu.
- **Notes:** a dated stream (*Stream* at the top of the library); titles optional.
- **Diary:** set a passphrase the first time. **If you lose it, your entries
  are lost.** Entries are encrypted in the browser; the server never sees the
  text. It locks after 5 minutes without activity (Settings to change).
  *Export diary, decrypted* in the ⋯ menu saves a readable copy, made in the browser.
  See [docs/SECURITY.md](docs/SECURITY.md).
- **Inbox:** captures wait under *Inbox* in the library footer until you turn
  them into a document, append them to one, or mark them done.
- **Trash:** deleted items stay for 30 days, then are removed for good.
- **E-ink:** Settings → *E-ink (high contrast)*, or open any page with
  `?theme=eink`. Typewriter scrolling (Settings) moves the page on every
  line; on e-ink you may prefer it off.
- **`/boox-test`** opens a bare editor with about 5,000 words and shows load
  time and keystroke latency at the bottom (`?typewriter=0` to compare,
  `?words=20000` for a longer text). Nothing there is saved.

### Clipping quotes from other web pages

Make a bookmark with this as its address (replace the host with yours), then
select text on any page and click the bookmark:

```text
javascript:(()=>{const h='https://YOUR-MACHINE.YOUR-TAILNET.ts.net';window.open(h+'/clip?quote='+encodeURIComponent(String(getSelection()))+'&title='+encodeURIComponent(document.title)+'&url='+encodeURIComponent(location.href),'cadence-clip','width=480,height=720')})()
```

It opens Cadence's clip page in a small window with the quote, title and
address filled in; add the author and page and save.

## Configuration

| Setting | Flag | Default |
|---|---|---|
| `CADENCE_DB` | `--db` | `data/cadence.sqlite3` in the project |
| `CADENCE_HOST` | `--host` | `127.0.0.1` (keep it; Tailscale serve reaches it locally) |
| `CADENCE_PORT` | `--port` | `8765` |
| `CADENCE_STATIC` | `--static` | `frontend/dist` |
| `CADENCE_ALLOWED_HOSTS` | | extra host names to answer to, comma separated (`*.example.lan` allowed) |
| `CADENCE_BACKUP_DIR` | `--dest` (backup) | `backups/` in the project |

## Troubleshooting

### Blank page on Windows

**Symptom:** the browser tab shows the title "Cadence" and the icon, but the
page stays empty. The browser's developer console reports that a module script
was refused because its MIME type is `text/plain`.

**Cause:** Python's `mimetypes` module takes file types from the Windows
registry. On some machines `.js` is registered there as `text/plain` (an
editor or another program changed `HKEY_CLASSES_ROOT\.js` → `Content Type`).
The server then sent the app's JavaScript as plain text, and browsers will not
run a module script with that type.

**Status:** fixed. Cadence now sets the types of everything it serves
(`.js`/`.mjs` as `text/javascript`, `.css`, `.json`, `.webmanifest`, `.svg`,
`.woff2`, `.png`, `.ico`, `.html`) itself and no longer depends on the
registry; `tests/test_static.py` simulates the broken registry. If you see a
blank page after updating, rebuild the frontend (`npm run build` in
`frontend`), restart Cadence, and reload the page with Ctrl+F5 so the browser
does not reuse an old copy. You do not need to change the registry.

## Adding a kind

Kinds live in one registry, `cadence/kinds.py`. To add one, add a
`register(Kind(...))` entry: label, which editor extensions it allows (from
the names in `cadence/content.py` / `frontend/src/editor/extensions.ts`),
typography tokens and accent, tools, `searchable`, `exportable`, `encrypted`,
`folders_enabled` and a list view (`tree`, `stream`, `ordered`, `by-month`).
Nothing else changes: the API, search, export, sidebar, editor and theme all
read the registry (`tests/test_registry.py` checks this). Then run
`python scripts/dump_kinds.py` to refresh the frontend test fixture.

## Design decisions

These are the choices you might want to revisit.

- **Word export uses python-docx on the server.** It is the long-standing,
  maintained library for writing .docx from Python, installs cleanly on
  Windows and on the Pi (lxml wheels), produces real Word styles (Title,
  Heading, Quote, List), and keeps all three exporters in one tested place
  instead of shipping a large docx library to every browser (including the
  Boox). It has no footnote API, so Cadence adds a proper footnotes part
  itself; LibreOffice opens and renders them (checked in the tests).
- **Diary key derivation is PBKDF2-SHA256 with 600,000 iterations**, not
  Argon2id: PBKDF2 is built into every browser's WebCrypto, Argon2 would need
  a WebAssembly library. The iteration count is stored per diary so it can be
  raised later.
- **"Local-first"** here means your data lives in one SQLite file on your own
  machine, and unsaved edits survive a dropped connection (kept on the device
  until the server confirms them). It is not a multi-device offline sync
  engine: if two devices edit the same document at once, the second save is
  refused, the device's version is kept as a snapshot, and you see the other
  version. Nothing is lost, but nothing is merged either.
- **Sessions** start with your first edit and end when you end them (Ctrl+.),
  switch documents, go idle for 20 minutes, or close the page. The re-entry
  note is asked for when you end deliberately, or when leaving a session of
  at least 5 minutes or 50 words; short touch-ups pass silently.
- **Capture is off in the diary**: the inbox is not encrypted, so a thought
  captured there could leak. The capture box says so.
- **Diary snapshots have dated names only** (a name would be stored unencrypted).
- **Spellcheck is off in the diary**, because some browsers send text to a
  cloud spell-checker.
- **Ordering:** folders are listed before documents at each level. Notes and
  diary entries are ordered by date; essays, poetry and fiction by hand.
- **Moving a document out of a folder** puts it at the end of the new level;
  keyboard indent puts a document into the nearest folder above it.
- **Fonts:** Literata (bundled, OFL) for essays and fiction, system fonts
  otherwise. Nothing is fetched from a font service.
- **Port 8765**, bound to localhost by default.
- **Search** matches all words, the last as a prefix (`walk` finds walking).
- Notes, poetry and fiction have no research pane; essays do. That is one
  flag per kind in the registry.

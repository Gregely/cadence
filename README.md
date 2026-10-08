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
- Installable as a PWA. Paper, dark, high-contrast e-ink, Analogue and
  Analogue Dark themes. No animations.

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
   - [Themes](#themes)
   - [Writing fiction](#writing-fiction)
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
# drives the app at desktop and phone size in every theme, and saves
# screenshots to frontend\test-results. Needs Chrome, Edge or Chromium installed
# (set CADENCE_BROWSER to its path if it is not found).
npm run build
npm run smoke
cd ..
```

To look at the themes, `npm run themes` (after `npm run build`, in
`frontend`) walks through every kind and the main views — chapter view, split
view, reading mode, timeline, draft mode, dialogs, menus, a locked and an open
diary — at desktop and phone size in each theme, and saves a screenshot of
each to `frontend/test-results/themes/<theme>/`. `--themes analogue,dark`
picks themes; `--db seed.sqlite3 --out before` keeps the sample library and
names the output, and `--compare before after` checks two runs are identical
in computed style (how the paper, dark and e-ink themes were proved unchanged
when the Analogue themes were added).

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
| Ctrl+Shift+D | Draft mode: only the text, the word count and *Next scene* (fiction) |
| Ctrl+Shift+Enter | Next scene, right below the current one (fiction) |
| Ctrl+Shift+P | Search this project (fiction) |
| `[[ … ]]` | A TODO marker in a scene (fiction; left out of compile) |
| Reading mode: ← → Space, PgUp/PgDn, tap a side | Turn the page; Esc closes |
| `* * *` then space | Section break |
| Library: arrows, Enter, F2, Del | Move, open, rename, trash |
| Library: Alt+Shift+↑↓ / →← | Move up/down, indent/outdent |
| Ctrl+/ | All shortcuts |

- **Formatting** appears as a small floating bar when you select text. There
  are no font, size or colour controls: the kind and theme decide.
- **Poetry:** Enter starts a new line, Enter on a blank line starts a new
  stanza, Tab indents. Lines are never reflowed or justified.
- **Fiction:** see [Writing fiction](#writing-fiction) below.
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
- **Themes:** see [Themes](#themes) below.
- **`/boox-test`** opens a bare editor with about 5,000 words and shows load
  time and keystroke latency at the bottom (`?typewriter=0` to compare,
  `?words=20000` for a longer text). Nothing there is saved.

### Themes

Settings (library footer) lists five themes. The choice is remembered on this
device; add `?theme=…` to any address to try one for a single visit.

- **Paper** (the default), **Dark**, and **E-ink (high contrast)**: black on
  white, borders instead of shadows, larger targets.
- **Analogue**: putty window surfaces around a parchment page, softly raised
  buttons that visibly go down when pressed, sunken fields and library, a
  sunken status strip, thin framed dialogs, and a sage accent.
- **Analogue Dark**: the same design in warm charcoal and umber, with a warm
  dark page and off-white text.

In both Analogue themes each kind has its own accent, shown as a thin stripe
along the top of the window and in links and footnote numbers. A faint grain
on the window frame (never under the page) is on by default; Settings →
*Grain texture* turns it off. Every text colour meets WCAG AA on every
surface it is drawn on, and the page text is 12:1 or better.

**Tweaking a palette.** All the colours of both Analogue themes are the
token blocks at the top of `frontend/src/styles/analogue.css`: `--bg` is the
window, `--page` the writing page, `--well` the sunken library and status
strip, `--field` inputs, `--face` buttons (`--face-pressed` when pressed),
`--bevel-hi`/`--bevel-lo` the light and shadow edges, `--ink`/`--muted`/
`--faint` the three text tones, `--dim` the dimmed paragraphs in focus mode,
`--line` rules on the page, `--edge` the outlines of controls, and `--focus`
the focus ring. The kind accents are the `.layout[data-kind='…']` blocks just
below. Change a value, then run `npm test` (it checks every text and surface
pair for contrast and fails if one drops below AA) and `npm run build`; `npm
run themes -- --themes analogue` shows the result. Nothing outside the token
blocks writes a colour (a test checks that too).

### Writing fiction

Everything here is optional and hidden until you ask for it; none of it ever
gets between you and the text.

- **Projects, chapters, scenes.** A top-level folder is a project; folders
  inside are parts or chapters; documents are *scenes*. A document can
  instead be a *misc note* (a character, a place, research): it lives in the
  same folders but stays out of the manuscript, its word counts and compile.
  Change a document's role in *Details*.
- **Chapter view.** Click a folder to see every scene in it (and in its
  sub-folders) as one long page, in library order, with `#` between scenes.
  Each scene is still its own document with its own autosave; only the
  scenes near the screen get an editor, so long chapters open quickly. Misc
  notes wait in a collapsed *Misc notes* strip at the end of their folder.
  The arrow beside a folder still folds it.
- **Stubs.** A scene with no text shows as a dashed placeholder with its
  one-line synopsis, so gaps are visible; click it to start writing.
- **Next scene** (button under the scene, Ctrl+Shift+Enter) makes a new scene
  directly below the current one, puts the cursor in it, and shows the
  re-entry note you left on the scene before.
- **Draft mode** (Ctrl+Shift+D) hides everything but the text, the word count
  and *Next scene*. It stays on for fiction until you switch it off (the
  small × beside the word count does that on a phone).
- **Details** (topbar) shows the current scene's status — stub □, drafted ◧,
  revised ▣, done ■ — its one-line synopsis, point of view, in-story date
  (`1888-03-14`, optionally `T21:30`), word target (a quiet bar appears
  beside the word count when one is set), role, and a collapsed *Beats*
  checklist. Beats are notes for you and are never compiled.
- **Word counts** in the library roll up from scene to chapter to project and
  count scenes only; hide them with Settings → *Word counts in library*.
- **TODO markers.** Type `[[fix: anything]]` in a scene. It is outlined in
  the text, listed under ⋯ → *TODOs in this project* with its chapter and
  scene (click to jump to it), and left out of compiled files.
- **Split view.** ⋯ → *Open beside…*, *Open beside* in a library menu, or
  *Beside* in the misc-notes strip opens another scene or note next to the
  text. Both are editable and save on their own. (If you open the same scene
  in both places and type in both, the second save is kept as a snapshot,
  as for any edit made on two devices at once.)
- **Search this project** (Ctrl+Shift+P) searches scenes and misc notes in the
  current project, with chapter and scene for each result; tick *All fiction*
  to widen it.
- **Reading mode.** ⋯ → *Read “Chapter …”* (or *Read* in a folder's menu)
  shows the chapter as pages with no editing at all. Tap the left third of
  the page to go back, anywhere else to go on.
- **Timeline.** Once two or more scenes have an in-story date, ⋯ →
  *Timeline* lists the project's scenes in story order.
- **Forward-only drafting.** ⋯ → *Forward-only drafting* (off by default, and
  off again after a reload) makes every paragraph before the one you are
  writing read-only. Press Enter to move on; switch it off to revise.
- **Compile.** A project's (or part's, or chapter's) ⋯ menu → *Compile…*
  makes a Word manuscript in standard submission format — Times New Roman
  12pt, double-spaced, 1-inch margins, half-inch indents, each chapter on a
  new page a third of the way down, `#` between scenes, a running
  *Surname / TITLE / page* header and an optional title page with your name
  and the word count rounded to the nearest hundred. Markdown and HTML are
  there too. Misc notes, beats and TODO markers are never included; if
  markers are left, the dialog says so but still compiles.
- **Draft sets.** ⋯ → *Draft sets…* saves the text of every document in the
  project under a name (“Draft 1”). Later, compare the current scene with a
  set paragraph by paragraph, or restore that scene, or the whole project.
  A restore first takes an automatic “Before restoring …” set, never deletes
  anything, leaves documents written since the set as they are, and brings
  back documents deleted since.

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

## Upgrading

Back up first (`scripts\backup.ps1` or `scripts/backup.sh`), then update the
code, `npm run build`, and restart Cadence. Database changes run by
themselves on start-up, once each, and only ever add: this release adds a
`role` column to documents (filled in from the kinds registry: existing
fiction documents become scenes) and the draft-set tables. Every existing
value is left as it was; `tests/test_upgrade.py` checks this against a
database filled with every kind, diary included.

## Adding a kind

Kinds live in one registry, `cadence/kinds.py`. To add one, add a
`register(Kind(...))` entry: label, which editor extensions it allows (from
the names in `cadence/content.py` / `frontend/src/editor/extensions.ts`),
typography tokens and accent, tools, `searchable`, `exportable`, `encrypted`,
`folders_enabled` and a list view (`tree`, `stream`, `ordered`, `by-month`).
Optional: `roles` (the first is the default; a role marked
`manuscript=False` stays out of the flow, counts and compile), `meta_fields`
(any of `synopsis`, `pov`, `story_date`, `beats`), `status_symbols`, and the
manuscript tools in `Tools` (`combined_view`, `draft_mode`, `next_document`,
`inspector`, `compile`, `draft_sets`, `todo_markers`, `split_view`,
`project_search`, `reading_mode`, `timeline`, `forward_only`).
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
- **Fiction statuses are squares** (□ ◧ ▣ ■): the quarter-filled circles
  first tried fell back to tiny glyphs in common fonts. They are set in the
  registry (`status_symbols`).
- **Chapter view order** is the library's: sub-folders first, then the
  folder's own scenes. Clicking a fiction folder opens the chapter view; its
  arrow folds it.
- **Next scene** shows the *previous* scene's re-entry note, since a brand-new
  scene has none of its own.
- **Draft mode keeps a tiny ×** beside the word count, so it can be left on a
  touch screen without a keyboard.
- **The details pane, split view and project lists share the side pane**;
  opening one closes the other.
- **Forward-only drafting** applies to every open editor: in a chapter view the
  scene with the cursor keeps that paragraph open, other scenes only their
  last paragraph. A click into a read-only paragraph keeps the cursor where you
  were writing.
- **Draft sets cover the whole project** (scenes and misc notes), whichever
  folder you open them from. Restores put text and titles back, never the
  folder structure.
- **Compile** rounds the title-page word count to the nearest hundred
  (“about 81,200 words”), puts parts and chapters on new pages, and uses `#`
  for scene breaks in all three formats. The author name is remembered on
  this device only.
- **TODO markers count as words** in the live word counts (they are short);
  compile counts without them.
- **The Analogue themes show each kind as a 3px stripe** along the top of the
  window (and in link underlines, footnote numbers and the re-entry bar). The
  paper and dark themes compute their accent once for the whole page, so in
  practice every kind shares one accent there; that was left exactly as it
  was.
- **Analogue sizes on touch screens:** every control is at least 40px. Where
  a bar has to keep its height (breadcrumbs, the status strip), the control's
  hit area grows and a negative margin gives the space back, so the bars do
  not get taller.
- **Analogue Dark outlines controls in near-black** (`--edge`) but draws
  rules on the page in a lighter umber (`--line`), so separators stay
  visible on the dark page.
- **Grain** is a 160px SVG noise tile drawn once by the browser, on the
  toolbar, the library frame and the side pane only. The writing area, split
  view, reading mode and dialogs paint a solid colour.
- **Existing themes untouched:** paper and dark keep some pale grey labels
  (word counts in the library, hints) below AA contrast. They were left as
  they are, since this change was not to alter those themes.

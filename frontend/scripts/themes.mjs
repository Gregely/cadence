// Theme tour: drives the built UI through every kind and the main views in
// the themes you name, at desktop and phone size, and saves a screenshot and
// a computed-style fingerprint of each view. Use it to look at a theme, or to
// prove a change left a theme exactly as it was:
//
//   npm run build
//   node scripts/themes.mjs --themes analogue,analogue-dark
//   node scripts/themes.mjs --themes paper,dark,eink --db seed.sqlite3 --out before
//   ... change things, build ...
//   node scripts/themes.mjs --themes paper,dark,eink --db seed.sqlite3 --out after
//   node scripts/themes.mjs --compare before after
//
// --db keeps the seeded library in a file, so two runs show exactly the same
// documents and dates (the browser clock is fixed too). Output defaults to
// test-results/themes/<theme>/<view>.png and .json.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

import { browserPath } from './browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, '..');
const repo = resolve(frontend, '..');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

if (args[0] === '--compare') process.exit(compare(resolve(args[1]), resolve(args[2])));

const themes = opt('themes', 'paper,dark,eink,analogue,analogue-dark').split(',');
const only = opt('only', '')?.split(',').filter(Boolean) ?? [];
const outRoot = resolve(opt('out', join(frontend, 'test-results', 'themes')));
const seedDb = opt('db', '') ? resolve(opt('db', '')) : '';
const port = Number(process.env.THEMES_PORT || 8798);
const base = `http://127.0.0.1:${port}`;
const PASS = 'tour passphrase for screenshots';

const python = [
  join(repo, '.venv', 'Scripts', 'python.exe'),
  join(repo, '.venv', 'bin', 'python'),
].find((p) => existsSync(p)) || (process.platform === 'win32' ? 'python' : 'python3');

if (!existsSync(join(frontend, 'dist', 'index.html'))) {
  console.error('Build the frontend first: npm run build');
  process.exit(2);
}

// ------------------------------------------------------------ server

function startServer(db) {
  const proc = spawn(python, ['-m', 'cadence', '--port', String(port), '--db', db, '--static', join(frontend, 'dist')], {
    cwd: repo, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  proc.log = () => log;
  return proc;
}

async function waitForServer(proc) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/kinds`)).ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${proc.log()}`);
}

async function stopServer(proc) {
  const done = new Promise((r) => proc.once('exit', r));
  proc.kill();
  await done;
}

const copyDb = (from, to) => {
  for (const ext of ['', '-wal', '-shm']) if (existsSync(from + ext)) copyFileSync(from + ext, to + ext);
};

async function api(path, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

// ------------------------------------------------------------ seed

const p = (...parts) => ({ type: 'paragraph', content: parts.map((t) => (typeof t === 'string' ? { type: 'text', text: t } : t)) });
const doc = (...blocks) => JSON.stringify({ type: 'doc', content: blocks });
const lorem = 'The reeds bent under the wind and the water rose against the dyke, grey and patient, while the lamps came on one by one along the far bank. ';

async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('cadence:v1') }, key, new TextEncoder().encode(JSON.stringify(value))));
  return JSON.stringify({ v: 1, alg: 'AES-GCM', iv: Buffer.from(iv).toString('base64'), ct: Buffer.from(ct).toString('base64') });
}

async function seed() {
  // Essays: a folder, headings, quotes, emphasis, a link, a footnote, a cited clip.
  const series = await api('/api/folders', { kind: 'essay', name: 'Walking series' });
  const essay = await api('/api/documents', {
    kind: 'essay', title: 'On walking', folder_id: series.id, content_json: doc(
      p('The heron waited — “patient” as stone — at the edge of the ', { type: 'text', text: 'flooded', marks: [{ type: 'italic' }] }, ' field, and I waited with it.'),
      p('Walking is a way of ', { type: 'text', text: 'thinking with the feet', marks: [{ type: 'bold' }] }, '. ', { type: 'text', text: 'Thoreau', marks: [{ type: 'link', attrs: { href: 'https://example.org/walking' } }] }, ' said as much', { type: 'footnote', attrs: { text: 'Henry David Thoreau, “Walking”, 1862.' } }, '.'),
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'The long way round' }] },
      { type: 'blockquote', content: [p('In wildness is the preservation of the world.')] },
      p(lorem.repeat(3)),
      p(lorem.repeat(2)),
    ),
  });
  await api('/api/documents', { kind: 'essay', title: 'Second piece', folder_id: series.id, content_json: doc(p('Inside the folder.')) });
  await api('/api/documents', { kind: 'essay', title: 'Notes towards a preface', content_json: doc(p(lorem)) });
  await api('/api/clips', {
    quote: 'In wildness is the preservation of the world.', page: '12', note: 'The line everyone quotes.',
    source: { title: 'Walking', author: 'Henry David Thoreau', url: 'https://example.org/walking', published: '1862' },
    document_ids: [essay.id],
  });
  // Notes: a short stream.
  for (const t of ['Buy lamp oil.', 'The ferry timetable changes in October.', 'Idea: a story told by the lighthouse.']) {
    await api('/api/documents', { kind: 'note', plain_text: t });
  }
  // Poetry: stanzas and an indented line.
  const poem = await api('/api/documents', {
    kind: 'poetry', title: 'Heron', content_json: doc(
      p('grey at the water'), p('\twaiting'), p('the river forgets'), p(), p('second stanza, longer, so the line runs on a little'), p('\t\tand turns'),
    ),
  });
  // Fiction: a project, two chapters, scenes with statuses, a stub, a misc note, dates.
  const fen = await api('/api/folders', { kind: 'fiction', name: 'Fen' });
  const ch1 = await api('/api/folders', { kind: 'fiction', name: 'Chapter One', parent_id: fen.id });
  const ch2 = await api('/api/folders', { kind: 'fiction', name: 'Chapter Two', parent_id: fen.id });
  const flood = await api('/api/documents', {
    kind: 'fiction', title: 'Flood', folder_id: ch1.id, status: 'drafted', word_target: 800,
    meta: { synopsis: 'The water comes over the dyke.', pov: 'Mara', story_date: '1953-01-31T22:00' },
    content_json: doc(p('First paragraph of the flood. ' + lorem), p('Second paragraph, where the eel-catcher waits. [[fix: give him a name]] ' + lorem), p(lorem.repeat(2))),
  });
  await api('/api/documents', {
    kind: 'fiction', title: 'Reeds', folder_id: ch1.id, status: 'revised', meta: { story_date: '1953-02-01' },
    content_json: doc(p(lorem.repeat(3)), p(lorem.repeat(3)), p(lorem.repeat(3))),
  });
  await api('/api/documents', { kind: 'fiction', title: 'The storm', folder_id: ch1.id, status: 'stub', meta: { synopsis: 'The storm reaches the island.' } });
  const misc = await api('/api/documents', { kind: 'fiction', title: 'Eel-catcher', role: 'misc', folder_id: ch1.id, content_json: doc(p('Old man, knows the tides. Smokes a clay pipe.')) });
  await api('/api/documents', { kind: 'fiction', title: 'After', folder_id: ch2.id, status: 'done', meta: { story_date: '1953-02-03' }, content_json: doc(p('After the water, the eel-catcher counted boats. ' + lorem)) });
  // Inbox: one capture.
  await api('/api/inbox', { text: 'Herons and patience', from_kind: 'essay' });
  // Diary: a vault and one entry, sealed exactly as the browser does.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100_000;
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await api('/api/vaults/diary', { kdf: 'PBKDF2-SHA256', iterations, salt: Buffer.from(salt).toString('base64'), check_envelope: await seal(key, { check: 'cadence' }) });
  await api('/api/documents', { kind: 'diary', content_json: await seal(key, { doc: JSON.parse(doc(p('A quiet day. Walked to the dyke and back; the heron was there again.'), p(lorem))) }) });
  return { essay: essay.id, series: series.id, poem: poem.id, fen: fen.id, ch1: ch1.id, ch2: ch2.id, flood: flood.id, misc: misc.id, seededAt: Date.now() };
}

// ------------------------------------------------------------ views

const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const ready = (page) => page.waitForSelector('.ProseMirror');
const docMenu = (page) => page.click('button[aria-label="Document menu"]');
async function toDiary(page) {
  await page.goto(`${base}/`);
  await page.waitForSelector('.layout[data-kind]');
  for (let i = 0; i < 20 && await page.evaluate(() => document.querySelector('.layout').dataset.kind) !== 'diary'; i++) {
    await page.keyboard.press('Alt+4');
    await page.waitForTimeout(250);
  }
  await page.waitForSelector('.lock-form input[type=password]');
}
const openPhoneLibrary = (page) => page.tap('.toggle-sidebar');

const views = [
  ['essay', DESKTOP, async (page, ids) => { await page.goto(`${base}/d/${ids.essay}`); await ready(page); }],
  ['essay-selection', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/d/${ids.essay}`); await ready(page);
    await page.click('.ProseMirror p >> nth=1'); await page.waitForTimeout(250); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
    await page.waitForSelector('.format-bar', { state: 'visible' });
  }],
  ['essay-focus', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/d/${ids.essay}`); await ready(page);
    await page.click('.ProseMirror p >> nth=1'); await page.waitForTimeout(250); await page.keyboard.press('Control+Shift+f');
  }],
  ['essay-research', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/d/${ids.essay}`); await ready(page);
    await page.click('.ProseMirror'); await page.keyboard.press('Control+Shift+e'); await page.waitForSelector('.research .clip');
  }],
  ['settings-menu', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/d/${ids.essay}`); await ready(page);
    await page.click('.sidebar-foot button:has-text("Settings")'); await page.waitForSelector('.menu');
  }],
  ['doc-menu', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/d/${ids.essay}`); await ready(page);
    await docMenu(page); await page.waitForSelector('.menu');
  }],
  ['dialog', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/d/${ids.essay}`); await ready(page);
    await page.click('button[aria-label="New folder"]'); await page.waitForSelector('.modal input');
    await page.keyboard.type('A new folder');
  }],
  ['shortcuts', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/d/${ids.essay}`); await ready(page);
    await page.click('.ProseMirror'); await page.keyboard.press('Control+/'); await page.waitForSelector('.shortcuts');
  }],
  ['quick-open', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/d/${ids.essay}`); await ready(page);
    await page.keyboard.press('Control+p'); await page.keyboard.type('wa'); await page.waitForSelector('.quick-list li');
  }],
  ['notes', DESKTOP, async (page) => { await page.goto(`${base}/stream/note`); await page.waitForSelector('.stream-item'); }],
  ['poetry', DESKTOP, async (page, ids) => { await page.goto(`${base}/d/${ids.poem}`); await ready(page); }],
  ['inbox', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/d/${ids.essay}`); await ready(page);
    await page.click('.sidebar-foot button:has-text("Inbox")'); await page.waitForSelector('.screen-item');
  }],
  ['fiction-chapter', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/f/${ids.ch1}`); await page.waitForSelector('.combined-doc .ProseMirror');
    await page.locator('.combined-doc .ProseMirror').first().click(); await page.waitForTimeout(250);
  }],
  ['fiction-details', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/d/${ids.flood}`); await ready(page);
    await page.click('.topbar button:has-text("Details")'); await page.waitForSelector('.inspector');
  }],
  ['fiction-split', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/f/${ids.ch1}`); await page.waitForSelector('.combined-doc .ProseMirror');
    await page.locator('.notes-strip summary').click(); await page.click('.notes-strip button:has-text("Beside")');
    await page.waitForSelector('.split .ProseMirror');
  }],
  ['fiction-draft', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/f/${ids.ch1}`); await page.waitForSelector('.combined-doc .ProseMirror');
    await page.locator('.combined-doc .ProseMirror').first().click(); await page.waitForTimeout(250); await page.keyboard.press('Control+Shift+d');
  }],
  ['fiction-reading', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/f/${ids.ch1}`); await page.waitForSelector('.combined-doc .ProseMirror');
    await page.locator('.combined-doc .ProseMirror').first().click(); await page.waitForTimeout(250);
    await docMenu(page); await page.click('.menu button:has-text("Read “Chapter One”")'); await page.waitForSelector('.reader');
  }],
  ['fiction-timeline', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/d/${ids.flood}`); await ready(page);
    await docMenu(page); await page.click('.menu button:has-text("Timeline")'); await page.waitForSelector('.timeline-item');
  }],
  ['fiction-compile', DESKTOP, async (page, ids) => {
    await page.goto(`${base}/d/${ids.flood}`); await ready(page);
    await docMenu(page); await page.click('.menu button:has-text("Compile")'); await page.waitForSelector('.compile-form');
  }],
  ['diary-locked', DESKTOP, toDiary],
  ['diary-open', DESKTOP, async (page) => {
    await toDiary(page);
    await page.fill('.lock-form input[type=password]', PASS); await page.click('.lock-form button[type=submit]');
    await page.waitForSelector('.ProseMirror', { timeout: 20000 });
  }],
  // Phone.
  ['phone-essay', PHONE, async (page, ids) => { await page.goto(`${base}/d/${ids.essay}`); await ready(page); }],
  ['phone-library', PHONE, async (page, ids) => {
    await page.goto(`${base}/d/${ids.essay}`); await ready(page);
    await openPhoneLibrary(page); await page.waitForSelector('.sidebar', { state: 'visible' });
  }],
  ['phone-menu', PHONE, async (page, ids) => {
    await page.goto(`${base}/d/${ids.essay}`); await ready(page);
    await docMenu(page); await page.waitForSelector('.menu');
  }],
  ['phone-dialog', PHONE, async (page, ids) => {
    await page.goto(`${base}/d/${ids.essay}`); await ready(page);
    await page.click('.ProseMirror'); await page.keyboard.press('Control+/'); await page.waitForSelector('.shortcuts');
  }],
  ['phone-chapter', PHONE, async (page, ids) => { await page.goto(`${base}/f/${ids.ch1}`); await page.waitForSelector('.combined-doc .ProseMirror'); }],
  ['phone-details', PHONE, async (page, ids) => {
    await page.goto(`${base}/d/${ids.flood}`); await ready(page);
    await page.click('.topbar button:has-text("Details")'); await page.waitForSelector('.inspector');
  }],
  ['phone-reading', PHONE, async (page, ids) => {
    await page.goto(`${base}/f/${ids.ch1}`); await page.waitForSelector('.combined-doc .ProseMirror');
    await page.locator('.combined-doc .ProseMirror').first().tap();
    await docMenu(page); await page.click('.menu button:has-text("Read “Chapter One”")'); await page.waitForSelector('.reader');
  }],
  ['phone-poetry', PHONE, async (page, ids) => { await page.goto(`${base}/d/${ids.poem}`); await ready(page); }],
  ['phone-diary-locked', PHONE, toDiary],
];

/** Every element's look, so a run can be compared with another exactly. */
function fingerprint() {
  const props = ['color', 'background-color', 'background-image', 'border-top-color', 'border-right-color', 'border-bottom-color',
    'border-left-color', 'border-top-width', 'border-left-width', 'border-radius', 'box-shadow', 'outline-color', 'outline-style',
    'outline-width', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration-line', 'visibility', 'display'];
  const TRANSIENT = ['is-current', 'ProseMirror-focused'];
  const out = [];
  const walk = (el, path) => {
    const cs = getComputedStyle(el);
    out.push(`${path} ${props.map((k) => cs.getPropertyValue(k)).join('|')}`);
    for (const pseudo of ['::before', '::after', '::placeholder', '::selection']) {
      const ps = getComputedStyle(el, pseudo);
      if (pseudo === '::before' || pseudo === '::after' ? ps.content !== 'none' : el.matches('input, textarea, .ProseMirror')) {
        out.push(`${path}${pseudo} ${['color', 'background-color'].map((k) => ps.getPropertyValue(k)).join('|')}`);
      }
    }
    // Classes the editor moves with the cursor are left out of the path; their effect is in the values.
    const cls = (c) => (typeof c.className === 'string' ? c.className.split(/\s+/).filter((x) => x && !TRANSIENT.includes(x)) : []);
    [...el.children].forEach((c, i) => walk(c, `${path}>${c.tagName.toLowerCase()}${cls(c).map((x) => '.' + x).join('')}[${i}]`));
  };
  walk(document.documentElement, 'html');
  out.push(`meta theme-color ${document.querySelector('meta[name="theme-color"]')?.getAttribute('content')}`);
  return out;
}

async function tour(browser, ids) {
  let failed = 0;
  const fixed = new Date(ids.seededAt + 60 * 60 * 1000);
  for (const theme of themes) {
    const dir = join(outRoot, theme);
    mkdirSync(dir, { recursive: true });
    for (const [name, ctxOpts, go] of views) {
      if (only.length && !only.includes(name)) continue;
      const ctx = await browser.newContext(ctxOpts);
      // The theme as a saved setting (the way the switcher leaves it).
      await ctx.addInitScript((t) => {
        if (!localStorage.getItem('cadence.settings')) localStorage.setItem('cadence.settings', JSON.stringify({ theme: t }));
      }, theme);
      const page = await ctx.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push(e.message));
      page.on('request', (r) => { if (!r.url().startsWith(base) && !/^(data|blob):/.test(r.url())) problems.push(`outbound request ${r.url()}`); });
      await page.clock.setFixedTime(fixed);
      try {
        await go(page, ids);
        await page.waitForTimeout(350);
        check(await page.evaluate(() => document.documentElement.dataset.theme) === theme, `${theme}/${name}: theme not applied`);
        await page.mouse.move(0, 0);
        await page.screenshot({ path: join(dir, `${name}.png`) });
        writeFileSync(join(dir, `${name}.json`), JSON.stringify(await page.evaluate(fingerprint), null, 0));
      } catch (err) {
        problems.push(err.message.split('\n')[0]);
        await page.screenshot({ path: join(dir, `${name}-FAILED.png`) }).catch(() => undefined);
      }
      for (const prob of problems) {
        failed++;
        console.error(`FAIL ${theme}/${name}: ${prob}`);
      }
      await ctx.close();
    }
    console.log(`ok   ${theme}: ${dir}`);
  }
  return failed;

  function check(cond, msg) { if (!cond) throw new Error(msg); }
}

/** Compare two tour outputs: identical fingerprints, and pixel-identical screenshots. */
function compare(a, b) {
  let diffs = 0;
  let n = 0;
  for (const theme of readdirSync(a)) {
    for (const f of readdirSync(join(a, theme)).filter((x) => x.endsWith('.json'))) {
      n++;
      const other = join(b, theme, f);
      if (!existsSync(other)) { console.log(`missing ${theme}/${f}`); diffs++; continue; }
      const x = JSON.parse(readFileSync(join(a, theme, f), 'utf8'));
      const y = JSON.parse(readFileSync(other, 'utf8'));
      const changed = x.filter((line, i) => line !== y[i]);
      if (changed.length || x.length !== y.length) {
        diffs++;
        console.log(`style differs: ${theme}/${f} (${changed.length} element(s); first: ${changed[0]?.slice(0, 200)} -> ${y[x.indexOf(changed[0])]?.slice(0, 200)})`);
      }
      const png = f.replace('.json', '.png');
      if (!readFileSync(join(a, theme, png)).equals(readFileSync(join(b, theme, png)))) console.log(`pixels differ: ${theme}/${png} (check with an image diff)`);
    }
  }
  console.log(diffs ? `${diffs} of ${n} views differ` : `all ${n} views identical in computed style`);
  return diffs ? 1 : 0;
}

// ------------------------------------------------------------ run

const tmp = mkdtempSync(join(tmpdir(), 'cadence-themes-'));
const runDb = join(tmp, 'run.sqlite3');
let code = 0;
let server;
let browser;
try {
  let ids;
  if (seedDb && existsSync(seedDb)) {
    ids = JSON.parse(readFileSync(`${seedDb}.ids.json`, 'utf8'));
  } else {
    const seedPath = join(tmp, 'seed.sqlite3');
    server = startServer(seedPath);
    await waitForServer(server);
    ids = await seed();
    await stopServer(server);
    if (seedDb) {
      copyDb(seedPath, seedDb);
      writeFileSync(`${seedDb}.ids.json`, JSON.stringify(ids));
    }
    copyDb(seedPath, runDb);
  }
  if (seedDb && existsSync(seedDb)) copyDb(seedDb, runDb);
  server = startServer(runDb);
  await waitForServer(server);
  browser = await chromium.launch({ executablePath: browserPath() });
  code = (await tour(browser, ids)) ? 1 : 0;
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) await stopServer(server);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold the file briefly */ }
}
process.exit(code);

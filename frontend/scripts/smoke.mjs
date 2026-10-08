// Headless-browser smoke test: starts the real server on a temporary
// database, drives the built UI at desktop and phone size and in the e-ink
// theme, saves screenshots to test-results/, and exits non-zero on failure.
//
//   npm run build
//   npm run smoke
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

import { browserPath } from './browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, '..');
const repo = resolve(frontend, '..');
const out = join(frontend, 'test-results');
mkdirSync(out, { recursive: true });

const port = Number(process.env.SMOKE_PORT || 8799);
const base = `http://127.0.0.1:${port}`;
const tmp = mkdtempSync(join(tmpdir(), 'cadence-smoke-'));
const python = [
  join(repo, '.venv', 'Scripts', 'python.exe'),
  join(repo, '.venv', 'bin', 'python'),
].find((p) => existsSync(p)) || (process.platform === 'win32' ? 'python' : 'python3');

if (!existsSync(join(frontend, 'dist', 'index.html'))) {
  console.error('Build the frontend first: npm run build');
  process.exit(2);
}

const server = spawn(python, ['-m', 'cadence', '--port', String(port), '--db', join(tmp, 'smoke.sqlite3'), '--static', join(frontend, 'dist')], {
  cwd: repo,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const failures = [];
const notes = [];
const check = (cond, message) => {
  if (!cond) failures.push(message);
  return cond;
};

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/kinds`);
      if (r.ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${serverLog}`);
}

async function api(path, init) {
  const r = await fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  return r.status === 204 ? null : r.json();
}

/** Every page gets the same guards: no errors, no requests leaving the origin. */
function guard(page, label) {
  page.on('pageerror', (e) => failures.push(`${label}: page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') failures.push(`${label}: console error: ${m.text()}`); });
  page.on('request', (r) => {
    const url = r.url();
    if (!url.startsWith(base) && !url.startsWith('data:') && !url.startsWith('blob:')) {
      failures.push(`${label}: outbound request to ${url}`);
    }
  });
}

async function typeInEditor(page, text) {
  await page.keyboard.type(text, { delay: 5 });
}

const steps = [];
const step = (name, fn) => steps.push([name, fn]);

let browser;

step('desktop: write, autosave, reopen at the cursor', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  guard(page, 'desktop');
  await page.goto(base + '/');
  await page.waitForSelector('.ProseMirror');
  check(await page.locator('.sidebar').isVisible(), 'sidebar should be shown by default on desktop');
  await page.click('.doc-title');
  await page.keyboard.type('On walking');
  await page.keyboard.press('Enter');
  await typeInEditor(page, 'The heron waited -- "patient" as stone. ');
  await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved', null, { timeout: 5000 });
  const tree = await api('/api/kinds/essay/tree');
  check(tree.documents.length === 1 && tree.documents[0].title === 'On walking', 'document created with its title');
  const doc = await api(`/api/documents/${tree.documents[0].id}`);
  check(doc.plain_text.startsWith('The heron waited — “patient” as stone.'), `smart quotes and dash saved (got ${JSON.stringify(doc.plain_text)})`);
  // Put the cursor after "heron", leave, and come back.
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150); // the editor reads arrow-key moves on 'selectionchange'
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(400);
  await page.goto(base + '/');
  await page.waitForSelector('.ProseMirror');
  await page.waitForTimeout(200);
  check(await page.inputValue('.doc-title') === 'On walking', 'reopens straight to the last document');
  await page.keyboard.type('X');
  await page.waitForTimeout(100);
  const text = await page.locator('.ProseMirror').innerText();
  check(text.startsWith('The heronX'), `cursor restored where it was left (got ${JSON.stringify(text.slice(0, 20))})`);
  await page.keyboard.press('Backspace');

  // Folder, new document inside it, quick open.
  await page.click('button[aria-label="New folder"]');
  await page.fill('.modal input', 'Walking series');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.row.folder');
  await page.hover('.row.folder');
  await page.click('.row.folder .more');
  await page.click('.menu button:has-text("New essay here")');
  await page.waitForTimeout(300);
  await page.keyboard.type('Second piece');
  await page.keyboard.press('Enter');
  await typeInEditor(page, 'Inside the folder.');
  await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved');
  check((await page.locator('.crumbs').innerText()).includes('Walking series'), 'breadcrumb shows the folder');
  await page.keyboard.press('Control+p');
  await page.keyboard.type('on walk');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check(await page.inputValue('.doc-title') === 'On walking', 'quick open finds a title');

  // Keyboard reorder in the library: move the folder below the loose doc? (folders stay first) —
  // instead indent the loose document into the folder with Alt+Shift+Right.
  await page.locator('.row.doc', { hasText: 'On walking' }).focus();
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await page.waitForTimeout(400);
  const moved = await api('/api/kinds/essay/tree');
  const folderId = moved.folders[0].id;
  check(moved.documents.every((d) => d.folder_id === folderId), 'keyboard indent moved the document into the folder');

  // Capture without leaving the page.
  await page.click('.ProseMirror');
  await page.keyboard.press('Control+Shift+Space');
  await page.waitForSelector('.capture input');
  await page.keyboard.type('Herons and patience');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.capture', { state: 'detached' });
  const inbox = await api('/api/inbox');
  check(inbox.length === 1 && inbox[0].from_kind === 'essay', 'capture saved to inbox tagged with the kind');
  check(await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), 'focus returns to the editor after capture');

  // Focus mode hides the sidebar and dims all but the current paragraph.
  await page.keyboard.press('Control+Shift+f');
  check(!(await page.locator('.sidebar').isVisible()), 'focus mode hides the sidebar');
  check(await page.locator('.ProseMirror > .is-current').count() === 1, 'one current paragraph in focus mode');
  await page.screenshot({ path: join(out, 'desktop-focus.png') });
  await page.keyboard.press('Escape');

  // Selecting text shows the floating toolbar; it is hidden otherwise.
  check(!(await page.locator('.format-bar').isVisible()), 'format bar hidden without a selection');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Shift+End');
  await page.waitForTimeout(100);
  check(await page.locator('.format-bar').isVisible(), 'format bar appears on selection');
  await page.screenshot({ path: join(out, 'desktop.png') });

  // Inbox review screen.
  await page.click('.sidebar-foot button:has-text("Inbox")');
  await page.waitForSelector('.screen-item');
  check((await page.locator('.screen-item').innerText()).includes('Herons and patience'), 'inbox review lists the capture');
  await page.click('text=‹ Back to writing');
  await ctx.close();
});

step('notes: stream view', async () => {
  for (const text of ['first note', 'second note']) {
    await api('/api/documents', { method: 'POST', body: JSON.stringify({ kind: 'note', plain_text: text }) });
  }
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await ctx.newPage();
  guard(page, 'notes');
  await page.goto(base + '/stream/note');
  await page.waitForSelector('.stream-item');
  const items = await page.locator('.stream-item').allInnerTexts();
  check(items.length === 2 && items[0].includes('second note'), 'stream lists notes newest first');
  await page.screenshot({ path: join(out, 'notes-stream.png') });
  await ctx.close();
});

step('poetry: lines, stanzas and indentation survive', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await ctx.newPage();
  guard(page, 'poetry');
  await page.goto(base + '/');
  await page.waitForSelector('.ProseMirror');
  await page.keyboard.press('Alt+3');
  await page.waitForFunction(() => document.querySelector('.layout')?.getAttribute('data-kind') === 'poetry');
  await page.click('.doc-title');
  await page.keyboard.type('Heron');
  await page.keyboard.press('Enter');
  await page.keyboard.type('grey at the water');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('waiting');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second stanza');
  await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved');
  const tree = await api('/api/kinds/poetry/tree');
  const doc = await api(`/api/documents/${tree.documents[0].id}`);
  check(doc.title === 'Heron', `poem title (got ${doc.title})`);
  check(doc.plain_text === 'grey at the water\n\twaiting\n\nsecond stanza', `poem lines kept (got ${JSON.stringify(doc.plain_text)})`);
  await page.screenshot({ path: join(out, 'poetry.png') });
  await ctx.close();
});

for (const theme of ['eink', 'paper', 'dark']) {
  step(`phone 390x844, ${theme} theme`, async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    guard(page, `phone-${theme}`);
    await page.goto(`${base}/?theme=${theme}`);
    await page.waitForSelector('.ProseMirror');
    check(await page.evaluate(() => document.documentElement.dataset.theme) === theme, 'theme applied');
    check(!(await page.locator('.sidebar').isVisible()), `${theme}: sidebar collapsed by default on phone`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `${theme}: no horizontal overflow on phone (${overflow}px)`);
    await page.screenshot({ path: join(out, `phone-${theme}.png`) });
    await page.tap('.toggle-sidebar');
    check(await page.locator('.sidebar').isVisible(), `${theme}: sidebar opens from the toolbar`);
    await page.screenshot({ path: join(out, `phone-${theme}-library.png`) });
    // Tap a document in the library: it opens and the library closes.
    await page.locator('.row.doc').first().tap();
    await page.waitForTimeout(300);
    check(!(await page.locator('.sidebar').isVisible()), `${theme}: library closes after opening a document`);
    await page.tap('.focus-toggle');
    await page.waitForTimeout(100);
    const box = await page.locator('.ProseMirror').boundingBox();
    check(box && box.width > 300, `${theme}: editor keeps its width in focus mode on phone`);
    await page.screenshot({ path: join(out, `phone-${theme}-focus.png`) });
    if (theme === 'eink') {
      // No colour dependence: text is pure black on white, accents are black.
      const colours = await page.evaluate(() => {
        const s = getComputedStyle(document.querySelector('.ProseMirror .is-current') || document.querySelector('.ProseMirror'));
        const b = getComputedStyle(document.body);
        return { text: s.color, bg: b.backgroundColor, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() };
      });
      check(colours.text === 'rgb(0, 0, 0)' && colours.bg === 'rgb(255, 255, 255)' && colours.accent === '#000000',
        `e-ink colours are black on white (${JSON.stringify(colours)})`);
      const anim = await page.evaluate(() => [...document.querySelectorAll('*')].some((el) => {
        const cs = getComputedStyle(el);
        return cs.animationName !== 'none' || (cs.transitionDuration !== '0s' && cs.transitionDuration !== '');
      }));
      check(!anim, 'no animations or transitions anywhere');
    }
    await ctx.close();
  });
}

step('boox-test: 5,000 words, load and keystroke latency', async () => {
  const ctx = await browser.newContext({ viewport: { width: 758, height: 1024 } });
  const page = await ctx.newPage();
  guard(page, 'boox');
  const cdp = await ctx.newCDPSession(page);
  for (const rate of [1, 6]) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await page.goto(`${base}/boox-test?theme=eink`);
    await page.waitForFunction(() => window.booxStats);
    await page.keyboard.press('Control+End');
    for (let i = 0; i < 40; i++) await page.keyboard.type('a', { delay: 30 });
    await page.waitForTimeout(500);
    const stats = await page.evaluate(() => window.booxStats);
    check(stats.words >= 5000, 'boox-test has 5,000 words');
    notes.push(`boox-test at ${rate}x CPU slowdown: ${stats.words} words, editor ready in ${Math.round(stats.ready)} ms, ` +
      `keystroke avg ${Math.round(stats.avg)} ms, p95 ${Math.round(stats.p95)} ms over ${stats.samples.length} keys`);
    if (rate === 6) await page.screenshot({ path: join(out, 'boox-test.png') });
  }
  await ctx.close();
});

step('PWA: manifest and service worker', async () => {
  const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
  check(manifest.icons.some((i) => i.sizes === '512x512'), 'manifest has a 512px icon');
  const sw = await (await fetch(`${base}/sw.js`)).text();
  check(sw.includes("startsWith('/api/')"), 'service worker leaves /api alone');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  guard(page, 'pwa');
  await page.goto(base + '/');
  const registered = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  check(registered, 'service worker registers');
  await ctx.close();
});

let code = 0;
try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: browserPath() });
  for (const [name, fn] of steps) {
    const before = failures.length;
    try {
      await fn();
    } catch (err) {
      failures.push(`${name}: ${err.message.split('\n')[0]}`);
    }
    console.log(`${failures.length === before ? 'ok  ' : 'FAIL'} ${name}`);
  }
} catch (err) {
  failures.push(err.message);
} finally {
  await browser?.close();
  server.kill();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold the file briefly */ }
}
for (const n of notes) console.log(`note: ${n}`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n- ${failures.join('\n- ')}`);
  code = 1;
} else {
  console.log(`\nsmoke test passed; screenshots in ${out}`);
}
process.exit(code);

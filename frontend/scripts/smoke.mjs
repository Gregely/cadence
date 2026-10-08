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
  page.on('console', (m) => {
    // A 409 is the designed answer to a save made on top of an older version;
    // the conflict tests trigger it on purpose and check it is handled.
    if (m.type() === 'error' && !m.text().includes('status of 409')) failures.push(`${label}: console error: ${m.text()}`);
  });
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
  let doc = {};
  for (let i = 0; i < 50 && !(doc.plain_text || '').endsWith('second stanza'); i++) {
    await page.waitForTimeout(100);
    const tree = await api('/api/kinds/poetry/tree');
    if (tree.documents.length) doc = await api(`/api/documents/${tree.documents[0].id}`);
  }
  check(doc.title === 'Heron', `poem title (got ${doc.title})`);
  check(doc.plain_text === 'grey at the water\n\twaiting\n\nsecond stanza', `poem lines kept (got ${JSON.stringify(doc.plain_text)})`);
  await page.screenshot({ path: join(out, 'poetry.png') });
  await ctx.close();
});


step('poetry: snapshot, compare and restore', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, acceptDownloads: true });
  const page = await ctx.newPage();
  guard(page, 'snapshots');
  await page.goto(base + '/');
  await page.waitForSelector('.ProseMirror');
  check(await page.evaluate(() => document.querySelector('.layout').dataset.kind) === 'poetry', 'reopens in poetry');
  check(await page.locator('.topbar button:has-text("Snapshot")').isVisible(), 'snapshot button is prominent for poetry');
  await page.click('.topbar button:has-text("Snapshot")');
  await page.waitForSelector('.toast:has-text("Snapshot taken")');
  await page.click('.ProseMirror');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' changed');
  await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved');
  await page.click('.topbar button:has-text("Versions")');
  await page.waitForSelector('.snap-row');
  await page.click('.snap-row button:has-text("Compare")');
  await page.waitForSelector('.diff ins');
  check((await page.locator('.diff ins').innerText()).includes('changed'), 'compare marks the added words');
  await page.screenshot({ path: join(out, 'snapshots.png') });
  await page.click('.snap-row button:has-text("Restore")');
  await page.click('.dialog-actions button:has-text("Restore")');
  await page.waitForSelector('.toast:has-text("Restored")');
  const text = await page.locator('.ProseMirror').innerText();
  check(!text.includes('changed'), 'restore brings back the snapshot text');
  const tree = await api('/api/kinds/poetry/tree');
  const snaps = await api(`/api/documents/${tree.documents[0].id}/snapshots`);
  check(snaps.some((x) => x.label.startsWith('Before restoring')), 'the replaced text was kept as a snapshot');

  // Export from the document menu.
  await page.click('button[aria-label="Document menu"]');
  await page.click('.menu button:has-text("Export")');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.modal button:has-text("Word (.docx)")')]);
  check(dl.suggestedFilename() === 'Heron.docx', `docx download named after the poem (got ${dl.suggestedFilename()})`);
  await ctx.close();
});

step('fiction: project with ordered scenes, re-entry note, folder export', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, acceptDownloads: true });
  const page = await ctx.newPage();
  guard(page, 'fiction');
  await page.goto(base + '/');
  await page.waitForSelector('.ProseMirror');
  await page.keyboard.press('Alt+5');
  await page.waitForFunction(() => document.querySelector('.layout')?.dataset.kind === 'fiction');
  await page.click('button[aria-label="New folder"]');
  await page.fill('.modal input', 'The Novel');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.row.folder');
  for (const [title, body] of [['Arrival', 'She came by the late train.'], ['Departure', 'He left before dawn.']]) {
    await page.hover('.row.folder');
    await page.click('.row.folder .more');
    await page.click('.menu button:has-text("New scene here")');
    await page.waitForTimeout(300);
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
    await page.keyboard.type(body);
    await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved');
  }
  const nums = await page.locator('.row.doc .num').allInnerTexts();
  check(nums.join(' ') === '1. 2.', `scenes are numbered in order (got ${nums})`);
  // Drag the second scene above the first.
  await page.locator('.row.doc', { hasText: 'Departure' }).dragTo(page.locator('.row.doc', { hasText: 'Arrival' }), { targetPosition: { x: 40, y: 3 } });
  await page.waitForTimeout(500);
  const labels = await page.locator('.row.doc .label').allInnerTexts();
  check(labels.join(',') === 'Departure,Arrival', `drag and drop reorders scenes (got ${labels})`);
  await page.screenshot({ path: join(out, 'fiction.png') });
  // End the session deliberately and leave a re-entry note.
  await page.click('.ProseMirror');
  await page.keyboard.press('Control+.');
  await page.waitForSelector('.prompt-form input');
  await page.keyboard.type('Next: the letter arrives');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForSelector('.reentry.prominent');
  check((await page.locator('.reentry').innerText()).includes('Next: the letter arrives'), 're-entry note shown prominently on return');
  await page.screenshot({ path: join(out, 'fiction-reentry.png') });
  // Compile the project (fiction compiles instead of "export as one document").
  await page.hover('.row.folder');
  await page.click('.row.folder .more');
  check(!(await page.locator('.menu button:has-text("Export as one document")').count()), 'fiction folders compile instead of exporting');
  await page.click('.menu button:has-text("Compile")');
  await page.check('.compile-form input[value="md"]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.compile-form button[type=submit]')]);
  const path = await dl.path();
  const { readFileSync } = await import('node:fs');
  const md = readFileSync(path, 'utf8');
  check(md.indexOf('He left before dawn.') < md.indexOf('She came by the late train.') && md.startsWith('# The Novel'), 'compile follows the library order');
  await ctx.close();
});


/** A fiction project with nested folders and many scenes, made through the API. */
async function seedNovel(name, chapters = 3, scenes = 10) {
  const novel = await api('/api/folders', { method: 'POST', body: JSON.stringify({ kind: 'fiction', name }) });
  const part = await api('/api/folders', { method: 'POST', body: JSON.stringify({ kind: 'fiction', name: 'Part One', parent_id: novel.id }) });
  const out = { novel: novel.id, part: part.id, chapters: [], scenes: [] };
  for (let c = 1; c <= chapters; c++) {
    const ch = await api('/api/folders', { method: 'POST', body: JSON.stringify({ kind: 'fiction', name: `Chapter ${c}`, parent_id: part.id }) });
    out.chapters.push(ch.id);
    for (let i = 1; i <= scenes; i++) {
      const text = `Scene ${c}.${i} begins. ` + 'The keeper climbed the stair and the lamp turned. '.repeat(20);
      const content = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
      const d = await api('/api/documents', { method: 'POST', body: JSON.stringify({ kind: 'fiction', title: `Scene ${c}.${i}`, folder_id: ch.id, content_json: content }) });
      out.scenes.push(d.id);
    }
  }
  return out;
}

step('fiction: combined folder view, one editor per scene, draft mode', async () => {
  const novel = await seedNovel('The Lighthouse', 3, 10);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  guard(page, 'combined');
  await page.goto(base + '/');
  await page.waitForSelector('.sidebar');
  // Essays are unchanged: clicking a folder folds it, it does not open a view.
  await page.keyboard.press('Alt+1');
  await page.waitForFunction(() => document.querySelector('.layout')?.dataset.kind === 'essay');
  await page.locator('.row.folder').first().click();
  await page.waitForTimeout(200);
  check(!(await page.locator('.combined').count()), 'essay folders still fold instead of opening a combined view');
  check(await page.locator('.row.folder').first().getAttribute('aria-expanded') === 'false', 'essay folder folded');
  await page.locator('.row.folder').first().click();

  await page.keyboard.press('Alt+5');
  await page.waitForFunction(() => document.querySelector('.layout')?.dataset.kind === 'fiction');
  await page.locator('.row.folder', { hasText: 'Part One' }).click();
  await page.waitForSelector('.combined-doc .ProseMirror');
  await page.waitForTimeout(300);
  const sections = await page.locator('.combined-doc').count();
  const mounted = await page.locator('.combined-doc .ProseMirror').count();
  check(sections === 30, `combined view lists every scene in the part (${sections})`);
  check(mounted > 0 && mounted < 10, `editors are mounted lazily (${mounted} of ${sections})`);
  check(await page.locator('.combined .folder-heading').count() === 3, 'each chapter has a heading');
  check((await page.locator('.combined-doc .doc-heading').first().innerText()).includes('Scene 1.1'), 'each document has a small title heading');
  check(page.url().endsWith(`/f/${novel.part}`), 'folder view has its own address');
  // Each section saves to its own document.
  await page.locator('.combined-doc .ProseMirror').nth(0).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' FIRST-EDIT');
  await page.locator('.combined-doc .ProseMirror').nth(1).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' SECOND-EDIT');
  for (let i = 0; i < 50; i++) {
    const [a, b] = await Promise.all(novel.scenes.slice(0, 2).map((id) => api(`/api/documents/${id}`)));
    if (a.plain_text.endsWith('FIRST-EDIT') && b.plain_text.endsWith('SECOND-EDIT')) break;
    await page.waitForTimeout(100);
  }
  const [s1, s2, s3] = await Promise.all(novel.scenes.slice(0, 3).map((id) => api(`/api/documents/${id}`)));
  check(s1.plain_text.endsWith('FIRST-EDIT') && !s1.plain_text.includes('SECOND'), 'first scene saved to itself');
  check(s2.plain_text.endsWith('SECOND-EDIT') && !s2.plain_text.includes('FIRST'), 'second scene saved to itself');
  check(!s3.plain_text.includes('EDIT'), 'untouched scene unchanged');
  await page.screenshot({ path: join(out, 'fiction-combined.png') });
  // Conflict inside the view: someone else changes scene 2; our next edit is kept as a snapshot.
  await api(`/api/documents/${novel.scenes[1]}`, { method: 'PATCH', body: JSON.stringify({ plain_text: 'Changed on another device.' }) });
  await page.keyboard.type(' LOCAL');
  await page.waitForSelector('.toast:has-text("changed elsewhere")', { timeout: 8000 });
  const snaps = await api(`/api/documents/${novel.scenes[1]}/snapshots`);
  check(snaps.some((x) => x.label.includes('changed elsewhere')), 'conflict in a section kept the local version as a snapshot');
  check((await api(`/api/documents/${novel.scenes[1]}`)).plain_text === 'Changed on another device.', 'the other version is now shown and kept');
  // Scrolling further mounts more editors.
  await page.evaluate(() => { const s = document.querySelector('.writing'); s.scrollTop = s.scrollHeight; });
  await page.waitForTimeout(400);
  check(await page.locator('.combined-doc .ProseMirror').count() > mounted, 'scrolling mounts more editors');
  // Back to the first scene, then reload: the folder view and the scene come back.
  await page.locator('.combined-doc .ProseMirror').first().click();
  await page.waitForTimeout(900);
  await page.reload();
  await page.waitForSelector('.combined-doc .ProseMirror');
  await page.waitForTimeout(400);
  check(page.url().endsWith(`/f/${novel.part}`), 'reload reopens the folder view');
  check(await page.evaluate(() => document.activeElement?.closest('.combined-doc')?.getAttribute('data-doc')) === String(novel.scenes[0]),
    'reload puts the cursor back in the scene being written');
  // Draft mode: only the text and the word count.
  await page.keyboard.press('Control+Shift+d');
  check(!(await page.locator('.sidebar').isVisible()) && !(await page.locator('.topbar').isVisible()), 'draft mode hides library and toolbar');
  check(await page.locator('.word-count').isVisible(), 'draft mode keeps the word count');
  check(!(await page.locator('.combined .doc-heading').first().isVisible()), 'draft mode hides section headings');
  await page.screenshot({ path: join(out, 'fiction-draft-mode.png') });
  await page.reload();
  await page.waitForSelector('.combined-doc .ProseMirror');
  check(await page.evaluate(() => document.querySelector('.layout').classList.contains('draft-mode')), 'draft mode is remembered for fiction');
  await page.click('.draft-exit');
  check(await page.locator('.topbar').isVisible(), 'draft mode can be left with its × button');
  await ctx.close();

  // Phone, e-ink.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p2 = await phone.newPage();
  guard(p2, 'combined-phone');
  await p2.goto(`${base}/f/${novel.chapters[1]}?theme=eink`);
  await p2.waitForSelector('.combined-doc .ProseMirror');
  check(await p2.locator('.combined-doc').count() === 10, 'chapter view on the phone');
  const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `combined view fits the phone (${overflow}px)`);
  await p2.screenshot({ path: join(out, 'phone-eink-combined.png') });
  await phone.close();
});

step('fiction: scenes, misc notes, stubs, counts, inspector, next scene', async () => {
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const para = (t) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
  const project = await post('/api/folders', { kind: 'fiction', name: 'Harbour' });
  const chapter = await post('/api/folders', { kind: 'fiction', name: 'Chapter One', parent_id: project.id });
  const s1 = await post('/api/documents', { kind: 'fiction', title: 'Arrival', folder_id: chapter.id, content_json: para('Mara came off the ferry in the rain.') });
  const stub = await post('/api/documents', { kind: 'fiction', title: 'The storm', folder_id: chapter.id, status: 'stub', meta: { synopsis: 'The storm reaches the island.' } });
  const s3 = await post('/api/documents', { kind: 'fiction', title: 'Morning', folder_id: chapter.id, content_json: para('By morning the sea was flat.') });
  const misc = await post('/api/documents', { kind: 'fiction', title: 'Mara, character', role: 'misc', folder_id: chapter.id, content_json: para('Nineteen, stubborn, afraid of nothing but boats and more words here.') });
  // A re-entry note on the first scene, to be carried into the next one.
  const sess = await post('/api/sessions', { document_id: s1.id, words_start: 1 });
  await post(`/api/sessions/${sess.id}/end`, { reentry_note: 'Next: the letter from the mainland' });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  guard(page, 'fiction-core');
  await page.goto(`${base}/f/${chapter.id}`);
  await page.waitForSelector('.combined-doc');
  await page.waitForTimeout(300);
  check(await page.locator('.combined .scene-break').count() === 2, 'scene-break separators between the three scenes');
  check((await page.locator('.combined .scene-break').first().innerText()).trim() === '#', 'scene breaks are marked #');
  check((await page.locator('.stub-block').innerText()).includes('The storm reaches the island.'), 'stub shows its synopsis');
  check(await page.locator('.notes-strip').count() === 1 && !(await page.locator('.notes-strip').evaluate((d) => d.open)), 'misc notes in a collapsed strip');
  check(!(await page.locator('.combined-doc').allInnerTexts()).join(' ').includes('stubborn'), 'misc note text is not in the manuscript flow');
  const expected = 8 + 6; // words in the two written scenes
  check((await page.locator('.word-count').innerText()).startsWith(`${expected} words`), `word count covers scenes only (${await page.locator('.word-count').innerText()})`);
  // Library: scenes numbered, the misc note not; folder total without misc.
  const nums = await page.locator(`.row.doc[data-doc] .num`).allInnerTexts();
  check(nums.slice(-3).join(' ') === '1. 2. 3.', `scenes numbered 1-3 (${nums.slice(-3)})`);
  check(await page.locator(`.row.doc[data-doc="${misc.id}"] .num`).count() === 0, 'misc note not numbered');
  check((await page.locator(`.row.folder[data-folder="${chapter.id}"] .meta`).innerText()) === String(expected), 'chapter total counts scenes only');
  check(await page.locator(`.row.doc[data-doc="${stub.id}"]`).evaluate((r) => r.classList.contains('stub')), 'stub marked in the library');
  await page.screenshot({ path: join(out, 'fiction-chapter.png') });

  // Write into the stub.
  await page.click('.stub-block');
  await page.waitForFunction((id) => document.activeElement?.closest('.combined-doc')?.getAttribute('data-doc') === String(id), stub.id);
  await page.keyboard.type('The wind came first.');
  for (let i = 0; i < 40 && !(await api(`/api/documents/${stub.id}`)).plain_text; i++) await page.waitForTimeout(100);
  check((await api(`/api/documents/${stub.id}`)).plain_text === 'The wind came first.', 'clicking a stub opens it for writing');

  // Inspector: hidden until asked for.
  check(!(await page.locator('.inspector').count()), 'details are hidden by default');
  await page.click('.topbar button:has-text("Details")');
  await page.waitForSelector('.inspector .status-field');
  await page.check('.status-field input[value="drafted"]');
  await page.waitForTimeout(300);
  check((await api(`/api/documents/${stub.id}`)).status === 'drafted', 'status set from the details pane');
  check((await page.locator(`.row.doc[data-doc="${stub.id}"] .status-symbol`).innerText()) === '◧', 'status shown as a shape in the library');
  const date = page.locator('.inspector [data-field="story_date"] input');
  await date.fill('next Tuesday');
  await date.press('Enter');
  await page.waitForFunction(() => document.querySelector('.inspector .lock-status')?.textContent?.includes('story date'));
  await date.fill('1888-03-14');
  await date.press('Enter');
  await page.fill('.inspector [data-field="pov"] input', 'Mara');
  await page.press('.inspector [data-field="pov"] input', 'Enter');
  await page.fill('.inspector [data-field="word_target"] input', '20');
  await page.press('.inspector [data-field="word_target"] input', 'Enter');
  await page.waitForTimeout(500);
  const meta = (await api(`/api/documents/${stub.id}`)).meta;
  check(meta.story_date === '1888-03-14' && meta.pov === 'Mara' && meta.word_target === 20, `details saved (${JSON.stringify(meta)})`);
  check(await page.locator('.target-bar').isVisible(), 'progress bar shown once a target is set');
  await page.screenshot({ path: join(out, 'fiction-inspector.png') });
  // Writing after a metadata change still saves (no false conflict).
  await page.locator(`.combined-doc[data-doc="${stub.id}"] .ProseMirror`).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Then rain.');
  for (let i = 0; i < 40 && !(await api(`/api/documents/${stub.id}`)).plain_text.endsWith('rain.'); i++) await page.waitForTimeout(100);
  check((await api(`/api/documents/${stub.id}`)).plain_text.endsWith('Then rain.'), 'typing after a details change saves without a conflict');

  // Next scene, right below the first one, with the re-entry note carried over.
  await page.locator(`.combined-doc[data-doc="${s1.id}"] .ProseMirror`).click();
  await page.keyboard.press('Control+Shift+Enter');
  await page.waitForSelector('.reentry:not([hidden])');
  check((await page.locator('.reentry').innerText()).includes('the letter from the mainland'), 'next scene shows the re-entry note');
  await page.keyboard.type('A letter arrives.');
  await page.waitForTimeout(1500);
  const tree = await api('/api/kinds/fiction/tree');
  const order = tree.documents.filter((d) => d.folder_id === chapter.id).sort((a, b) => a.sort_order - b.sort_order).map((d) => d.title || d.excerpt);
  check(order[0] === 'Arrival' && order[1] === 'A letter arrives.' && order[2] === 'The storm', `next scene created right below (${order})`);

  // A misc note made a scene joins the flow; and back.
  await page.locator(`.combined-doc[data-doc="${s3.id}"] .ProseMirror`).click();
  await page.waitForTimeout(200);
  await page.selectOption('.inspector [data-field="role"] select', 'misc');
  await page.waitForFunction((id) => !document.querySelector(`.combined-doc[data-doc="${id}"]`), s3.id);
  check(await page.locator('.notes-strip li').count() === 2, 'a scene made misc moves into the notes strip');

  // Counts can be hidden.
  await page.click('.sidebar-foot button:has-text("Settings")');
  await page.click('.menu button:has-text("Word counts in library")');
  await page.waitForTimeout(300);
  check(await page.locator('.row .meta').count() === 0, 'library word counts can be hidden');
  await page.click('.sidebar-foot button:has-text("Settings")');
  await page.click('.menu button:has-text("Word counts in library")');
  // Draft mode keeps the next-scene button.
  await page.keyboard.press('Control+Shift+d');
  check(await page.locator('.draft-controls button:has-text("Next scene")').isVisible(), 'draft mode shows the next-scene button');
  await page.keyboard.press('Control+Shift+d');
  await ctx.close();

  // Phone, e-ink, with details open.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p2 = await phone.newPage();
  guard(p2, 'fiction-core-phone');
  await p2.goto(`${base}/f/${chapter.id}?theme=eink`);
  await p2.waitForSelector('.combined-doc');
  await p2.screenshot({ path: join(out, 'phone-eink-chapter.png') });
  await p2.locator('.combined-doc .ProseMirror').first().tap();
  await p2.tap('.topbar button:has-text("Details")');
  await p2.waitForSelector('.inspector .status-field');
  const box = await p2.locator('.side-pane').boundingBox();
  check(box && box.width >= 380, 'details fill the phone screen');
  await p2.screenshot({ path: join(out, 'phone-eink-details.png') });
  await phone.close();
});

step('fiction: compile with TODO warning, draft sets compare and restore', async () => {
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const para = (...t) => JSON.stringify({ type: 'doc', content: t.map((x) => ({ type: 'paragraph', content: [{ type: 'text', text: x }] })) });
  const project = await post('/api/folders', { kind: 'fiction', name: 'Saltmarsh' });
  const ch = await post('/api/folders', { kind: 'fiction', name: 'Chapter One', parent_id: project.id });
  const a = await post('/api/documents', { kind: 'fiction', title: 'Tide', folder_id: ch.id, content_json: para('The tide came in.', 'Gulls on the wire.') });
  await post('/api/documents', { kind: 'fiction', title: 'Dusk', folder_id: ch.id, content_json: para('Dusk [[fix: which month?]] fell early.') });
  await post('/api/documents', { kind: 'fiction', title: 'Places', role: 'misc', folder_id: ch.id, content_json: para('MISC-PLACES the marsh, the church') });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await ctx.newPage();
  guard(page, 'compile');
  await page.goto(`${base}/f/${ch.id}`);
  await page.waitForSelector('.combined-doc .ProseMirror');
  await page.locator(`.row.folder[data-folder="${project.id}"]`).hover();
  await page.click(`.row.folder[data-folder="${project.id}"] .more`);
  await page.click('.menu button:has-text("Compile")');
  await page.waitForSelector('.compile-warning:not([hidden])');
  check((await page.locator('.compile-warning').innerText()).includes('1 TODO marker is still in the text'), 'compile warns about TODO markers');
  check(await page.locator('.compile-form button[type=submit]').isEnabled(), 'the warning does not block compiling');
  await page.fill('.compile-form input[autocomplete="name"]', 'Ana Sousa');
  await page.screenshot({ path: join(out, 'fiction-compile.png') });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.compile-form button[type=submit]')]);
  check(dl.suggestedFilename() === 'Saltmarsh (manuscript).docx', `manuscript download (${dl.suggestedFilename()})`);
  const md = await (await fetch(`${base}/api/folders/${project.id}/compile?format=md`)).text();
  check(!md.includes('MISC-PLACES') && !md.includes('[[') && md.includes('Dusk fell early.'), 'compiled text has no misc notes and no markers');

  // Draft sets.
  await page.locator(`.combined-doc[data-doc="${a.id}"] .ProseMirror`).click();
  await page.click('button[aria-label="Document menu"]');
  await page.click('.menu button:has-text("Draft sets")');
  await page.fill('.take-set input', 'Draft 1');
  await page.click('.take-set button');
  await page.waitForSelector('.set-row');
  await page.keyboard.press('Escape');
  await page.locator(`.combined-doc[data-doc="${a.id}"] .ProseMirror`).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A new paragraph after the draft.');
  for (let i = 0; i < 40 && !(await api(`/api/documents/${a.id}`)).plain_text.includes('after the draft'); i++) await page.waitForTimeout(100);
  await page.click('button[aria-label="Document menu"]');
  await page.click('.menu button:has-text("Draft sets")');
  await page.waitForSelector('.set-row');
  await page.click('.set-row button:has-text("Compare this scene")');
  await page.waitForSelector('.para-diff');
  check((await page.locator('.para-diff ins').innerText()).includes('A new paragraph after the draft.'), 'paragraph diff shows the added paragraph');
  check(await page.locator('.para-diff p.same').count() === 2, 'unchanged paragraphs shown plainly');
  await page.screenshot({ path: join(out, 'fiction-draft-sets.png') });
  await page.click('.set-row button:has-text("Restore this scene")');
  await page.click('.dialog-actions button:has-text("Restore")');
  await page.waitForSelector('.toast:has-text("Restored")');
  check(!(await api(`/api/documents/${a.id}`)).plain_text.includes('after the draft'), 'restoring a scene brings back its text');
  const sets = await api(`/api/folders/${project.id}/draft-sets`);
  check(sets.sets.length === 2 && sets.sets[0].automatic && sets.sets[0].name.startsWith('Before restoring'), 'a safety set was taken first');
  check(!(await page.locator(`.combined-doc[data-doc="${a.id}"] .ProseMirror`).innerText()).includes('after the draft'), 'the open view shows the restored text');
  // Restore the whole project back from the safety set.
  await page.click('button[aria-label="Document menu"]');
  await page.click('.menu button:has-text("Draft sets")');
  await page.locator('.set-row.auto button:has-text("Restore whole project")').click();
  await page.click('.dialog-actions button:has-text("Restore")');
  await page.waitForSelector('.toast:has-text("Restored")');
  check((await api(`/api/documents/${a.id}`)).plain_text.includes('after the draft'), 'restoring the whole project from the safety set undoes the restore');
  await ctx.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p2 = await phone.newPage();
  guard(p2, 'draft-sets-phone');
  await p2.goto(`${base}/f/${ch.id}?theme=eink`);
  await p2.waitForSelector('.combined-doc .ProseMirror');
  await p2.locator('.combined-doc .ProseMirror').first().tap();
  await p2.tap('button[aria-label="Document menu"]');
  await p2.tap('.menu button:has-text("Draft sets")');
  await p2.waitForSelector('.set-row');
  await p2.screenshot({ path: join(out, 'phone-eink-draft-sets.png') });
  await phone.close();
});

step('research: clip, cite, footnote, search, reading notes, export', async () => {
  const essays = await api('/api/kinds/essay/tree');
  const essay = essays.documents.find((d) => d.title === 'On walking');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await ctx.newPage();
  guard(page, 'research');
  await page.goto(`${base}/d/${essay.id}`);
  await page.waitForSelector('.ProseMirror');
  await page.keyboard.press('Control+Shift+e');
  await page.waitForSelector('.research');
  await page.click('.research button:has-text("Clip a quote")');
  const form = page.locator('.research .clip-form');
  await form.locator('textarea').first().fill('In wildness is the preservation of the world.');
  const inputs = form.locator('input');
  await inputs.nth(0).fill('Walking');
  await inputs.nth(1).fill('Henry David Thoreau');
  await inputs.nth(2).fill('https://example.org/walking');
  await inputs.nth(3).fill('12');
  await inputs.nth(4).fill('1862');
  await form.locator('button[type=submit]').click();
  await page.waitForSelector('.research .clip');
  check((await page.locator('.research .clip blockquote').innerText()).includes('wildness'), 'clipped quote listed for the document');
  // Put the cursor at the end of the text and insert a footnote and a citation.
  await page.click('.ProseMirror');
  await page.keyboard.press('Control+End');
  await page.click('.research .clip button:has-text("Footnote")');
  await page.waitForTimeout(100);
  await page.click('.ProseMirror');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' As he said ');
  await page.click('.research .clip button:has-text("Cite")');
  await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved', null, { timeout: 5000 });
  await page.waitForTimeout(1200);
  await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved', null, { timeout: 5000 });
  const doc = await api(`/api/documents/${essay.id}`);
  check(doc.content_json.includes('"type":"footnote"') && doc.content_json.includes('Henry David Thoreau, “Walking”, 1862, p. 12'), 'footnote from source inserted');
  check(doc.content_json.includes('"type":"citation"') && doc.content_json.includes('(Thoreau 1862, p. 12)'), 'author-date citation inserted');
  await page.screenshot({ path: join(out, 'research.png') });
  // Search my writing and sources.
  await page.fill('.research input[type=search]', 'heron');
  await page.waitForSelector('.research .hit');
  await page.click('.research .hit');
  await page.waitForSelector('.research-preview');
  check((await page.locator('.research-preview').innerText()).length > 0, 'preview shows my own document in the pane');
  await page.click('.research button:has-text("Results")');
  await page.fill('.research input[type=search]', 'thoreau');
  await page.waitForSelector('.research .source');
  await page.click('.research .source button:has-text("Reading notes")');
  await page.waitForFunction(() => document.querySelector('.doc-title')?.value === 'Reading notes: Walking');
  check((await page.locator('.ProseMirror').innerText()).includes('Key quotes'), 'reading-notes template opened');
  // Export carries citations through.
  const md = await (await fetch(`${base}/api/documents/${essay.id}/export?format=md`)).text();
  check(md.includes('## Sources') && md.includes('(Thoreau 1862, p. 12)') && md.includes('p. 12'), 'export carries citations and sources');
  await ctx.close();

  // The bookmarklet page.
  const ctx2 = await browser.newContext({ viewport: { width: 480, height: 760 } });
  const p2 = await ctx2.newPage();
  guard(p2, 'clip-page');
  await p2.goto(`${base}/clip?quote=${encodeURIComponent('Walking is a virtue.')}&title=${encodeURIComponent('A Page')}&url=${encodeURIComponent('https://example.org/page')}`);
  await p2.waitForSelector('.clip-form');
  check(await p2.locator('.clip-form textarea').first().inputValue() === 'Walking is a virtue.', 'clip page is prefilled');
  await p2.screenshot({ path: join(out, 'clip-page.png') });
  await p2.click('.clip-form button[type=submit]');
  await p2.waitForSelector('text=Saved. You can close this window.');
  const sources = await api('/api/sources?q=A%20Page');
  check(sources.length === 1 && sources[0].url === 'https://example.org/page', 'clip page saved the source');
  await ctx2.close();

  // The pane on a phone, e-ink.
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p3 = await ctx3.newPage();
  guard(p3, 'research-phone');
  await p3.goto(`${base}/d/${essay.id}?theme=eink`);
  await p3.waitForSelector('.ProseMirror');
  await p3.tap('.topbar button:has-text("Research")');
  await p3.waitForSelector('.research .clip');
  const box = await p3.locator('.side-pane').boundingBox();
  check(box && box.width >= 380, 'research pane fills the phone screen');
  await p3.screenshot({ path: join(out, 'phone-eink-research.png') });
  await ctx3.close();
});

const SECRET = 'marmalade heron confession';
const PASS = 'correct horse battery staple';

/** Everything the browser keeps for this origin, as one string. */
async function browserStores(page) {
  return page.evaluate(async () => {
    const parts = [];
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) parts.push(store.key(i), store.getItem(store.key(i)));
    }
    if (indexedDB.databases) parts.push(JSON.stringify(await indexedDB.databases()));
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        parts.push(req.url);
        const res = await cache.match(req);
        const type = res.headers.get('content-type') || '';
        if (/text|json|javascript/.test(type)) parts.push(await res.text());
      }
    }
    return parts.join('\n');
  });
}

step('diary: setup warning, encryption, lock and unlock, nothing leaks', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, acceptDownloads: true });
  const page = await ctx.newPage();
  guard(page, 'diary');
  const sent = [];
  page.on('request', (r) => { const b = r.postData(); if (b) sent.push(r.url() + ' ' + b); });
  await page.goto(base + '/');
  await page.waitForSelector('.ProseMirror');
  await page.keyboard.press('Alt+4');
  await page.waitForSelector('.lock-form');
  const warning = await page.locator('.lock-form .warning').innerText();
  check(/lose this passphrase, your entries are lost/i.test(warning), 'setup warns that a lost passphrase means lost entries');
  check(/decrypted/i.test(warning), 'setup mentions the decrypted export');
  await page.screenshot({ path: join(out, 'diary-setup.png') });
  const inputs = page.locator('.lock-form input[type=password]');
  await inputs.nth(0).fill(PASS);
  await inputs.nth(1).fill(PASS);
  await page.click('.lock-form button[type=submit]');
  check((await page.locator('.lock-status').innerText()).includes('tick'), 'setup requires confirming the warning');
  await page.check('#lost-means-lost');
  await page.click('.lock-form button[type=submit]');
  await page.waitForSelector('.ProseMirror', { timeout: 20000 });
  await page.waitForTimeout(300);
  check(await page.locator('.ProseMirror').getAttribute('spellcheck') === 'false', 'spellcheck is off in the diary');
  await page.click('.ProseMirror');
  await page.keyboard.type(`Today: ${SECRET}.`);
  await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved', null, { timeout: 10000 });
  check(!(await page.locator('.word-count').isVisible()), 'no word count in the diary');

  // The server only has ciphertext.
  const tree = await api('/api/kinds/diary/tree');
  check(tree.documents.length === 1 && /^Entry \d{4}-\d\d-\d\d$/.test(tree.documents[0].title), `generic dated title (${tree.documents[0]?.title})`);
  const doc = await api(`/api/documents/${tree.documents[0].id}`);
  check(!JSON.stringify(doc).includes('marmalade') && !('plain_text' in doc), 'stored entry is ciphertext only');
  check(!sent.some((b) => b.includes('marmalade')), 'no request ever carried the plain text');
  const hits = await api('/api/search?q=marmalade&all_kinds=true');
  check(hits.length === 0, 'diary text is not searchable');

  // Capture is refused in the diary, and nothing reaches the inbox.
  await page.keyboard.press('Control+Shift+Space');
  await page.waitForSelector('.capture');
  check((await page.locator('.capture').innerText()).includes('Capture is off'), 'capture explains it is off in the diary');
  const inboxBefore = (await api('/api/inbox?include_handled=true')).length;

  // Snapshot of an encrypted entry is ciphertext too.
  await page.keyboard.press('Control+Shift+s'); // no name asked: labels are not encrypted
  await page.waitForSelector('.toast:has-text("Snapshot taken")');
  check(!(await page.locator('.modal').count()), 'diary snapshots are not named');

  // Decrypted export happens in the browser.
  await page.click('button[aria-label="Document menu"]');
  await page.click('.menu button:has-text("decrypted")');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.dialog-actions button:has-text("Save decrypted copy")')]);
  const { readFileSync } = await import('node:fs');
  check(readFileSync(await dl.path(), 'utf8').includes(SECRET), 'decrypted export contains the entry');

  // Browser storage holds nothing readable.
  check(!(await browserStores(page)).includes('marmalade'), 'no plain text in localStorage, sessionStorage, IndexedDB or caches');

  // Lock: the text leaves the page.
  await page.click('.topbar button:has-text("Lock")');
  await page.waitForSelector('.lock-form');
  check(!(await page.content()).includes('marmalade'), 'locking removes the decrypted text from the page');
  await page.screenshot({ path: join(out, 'diary-locked.png') });

  // Reload: the key was never stored, so it asks again.
  await page.reload();
  await page.waitForSelector('.lock-form input[type=password]');
  await page.fill('.lock-form input[type=password]', 'wrong passphrase here');
  await page.click('.lock-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('.lock-status')?.textContent?.includes('does not open'), null, { timeout: 20000 });
  await page.fill('.lock-form input[type=password]', PASS);
  await page.click('.lock-form button[type=submit]');
  await page.waitForSelector('.ProseMirror', { timeout: 20000 });
  check((await page.locator('.ProseMirror').innerText()).includes(SECRET), 'unlock decrypts the entry');
  check((await api('/api/inbox?include_handled=true')).length === inboxBefore, 'nothing was added to the inbox');
  const snaps = await api(`/api/documents/${tree.documents[0].id}/snapshots`);
  const snap = await api(`/api/snapshots/${snaps[0].id}`);
  check(!snap.content_json.includes('marmalade'), 'diary snapshots are ciphertext');
  await ctx.close();
});

step('diary: auto-lock after inactivity', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  guard(page, 'autolock');
  await page.clock.install();
  await page.goto(`${base}/?theme=eink`);
  await page.waitForSelector('.lock-form input[type=password]');
  await page.screenshot({ path: join(out, 'phone-eink-diary-locked.png') });
  await page.fill('.lock-form input[type=password]', PASS);
  await page.click('.lock-form button[type=submit]');
  await page.waitForSelector('.ProseMirror', { timeout: 20000 });
  check((await page.locator('.ProseMirror').innerText()).includes(SECRET), 'entry open before going idle');
  await page.clock.fastForward('06:00');
  await page.waitForSelector('.lock-form', { timeout: 5000 });
  check(!(await page.content()).includes('marmalade'), 'auto-lock after 5 idle minutes clears the text');
  await ctx.close();
});

for (const theme of ['eink', 'paper', 'dark']) {
  step(`phone 390x844, ${theme} theme`, async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    guard(page, `phone-${theme}`);
    // The app reopens the last document (now the locked diary), so open an essay by URL.
    const essays = await api('/api/kinds/essay/tree');
    await page.goto(`${base}/d/${essays.documents[0].id}?theme=${theme}`);
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
  // Content types come from the app, never from the OS (a Windows registry
  // mapping .js to text/plain once left the page blank).
  const type = async (path) => ((await fetch(base + path)).headers.get('content-type') || '').split(';')[0];
  const index = await (await fetch(`${base}/`)).text();
  const js = index.match(/src="(\/assets\/[^"]+\.js)"/)[1];
  const css = index.match(/href="(\/assets\/[^"]+\.css)"/)[1];
  for (const [path, want] of [[js, 'text/javascript'], [css, 'text/css'], ['/manifest.webmanifest', 'application/manifest+json'], ['/sw.js', 'text/javascript']]) {
    const got = await type(path);
    check(got === want, `${path} served as ${want} (got ${got})`);
  }
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

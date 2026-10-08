import type { JSONContent } from '@tiptap/core';

import { DocEditor } from './editor/doc-editor';
import { h } from './lib/dom';
import { applyTheme, settings } from './settings';
import type { KindDef } from './types';

/**
 * /boox-test: a bare editor preloaded with about 5,000 words, plus a small
 * readout of load time and keystroke latency, for checking e-ink devices.
 * Nothing here is saved.
 */
const WORDS = (
  'the of and a to in is was he that it for on with as his they at be this from have or by one had not but ' +
  'what all were when we there can an your which their said if do will each about how up out them then she ' +
  'many some so these would other into has more her two like him see time could no make than first been its ' +
  'who now people my made over did down only way find use may water long little very after words called just ' +
  'where most know river light morning window garden letter quiet evening harbour lantern paper silence ' +
  'kitchen orchard weather stone heron winter summer road bridge memory distance shadow table'
).split(' ');

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function sampleDoc(targetWords = 5000, seed = 7): { doc: JSONContent; words: number } {
  const rand = rng(seed);
  const pick = () => WORDS[Math.floor(rand() * WORDS.length)]!;
  const content: JSONContent[] = [];
  let words = 0;
  let section = 1;
  while (words < targetWords) {
    if (content.length % 12 === 0) {
      content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `Part ${section++}` }] });
      words += 2;
    }
    const sentences: string[] = [];
    const n = 3 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      const len = 8 + Math.floor(rand() * 16);
      const ws = Array.from({ length: len }, pick);
      ws[0] = ws[0]!.charAt(0).toUpperCase() + ws[0]!.slice(1);
      sentences.push(`${ws.join(' ')}.`);
      words += len;
    }
    const text = sentences.join(' ');
    const cut = text.indexOf(' ', Math.floor(text.length / 3));
    const end = text.indexOf(' ', cut + 12);
    content.push({
      type: 'paragraph',
      content: cut > 0 && end > cut
        ? [
          { type: 'text', text: text.slice(0, cut + 1) },
          { type: 'text', text: text.slice(cut + 1, end), marks: [{ type: 'italic' }] },
          { type: 'text', text: text.slice(end) },
        ]
        : [{ type: 'text', text }],
    });
  }
  return { doc: { type: 'doc', content }, words };
}

const BOOX_KIND: KindDef = {
  id: 'essay',
  label: 'Boox test',
  extensions: ['typography', 'heading:2,3', 'bold', 'italic', 'link', 'blockquote', 'footnote', 'sectionBreak', 'hardBreak'],
  theme: {
    font_body: "'Literata', Georgia, serif",
    font_heading: "'Literata', Georgia, serif",
    font_size: '1.125rem',
    line_height: '1.65',
    measure: '38rem',
    paragraph_gap: '0.9em',
    text_indent: '0',
    accent: '#8a5a2b',
    accent_dark: '#d9a46c',
  },
  tools: {
    research_pane: false, session_timer: false, word_target: false, status: false, word_count: true, snapshots: 'off', reentry: 'off',
    combined_view: false, draft_mode: false, next_document: false, inspector: false, compile: false, draft_sets: false,
    todo_markers: false, split_view: false, project_search: false, reading_mode: false, timeline: false, forward_only: false,
  },
  searchable: false,
  exportable: false,
  encrypted: false,
  folders_enabled: false,
  list_view: 'tree',
  statuses: [],
  title_mode: 'optional',
  placeholder: '',
  folder_label: 'Folder',
  item_label: 'Document',
  capture_allowed: false,
  sessions_allowed: false,
  roles: [],
  default_role: null,
  meta_fields: [],
  status_symbols: {},
};

export function booxTest(root: HTMLElement): void {
  const t0 = performance.now();
  applyTheme(settings().theme);
  document.title = 'Boox test · Cadence';
  const params = new URLSearchParams(window.location.search);
  const target = Math.max(100, Math.min(50000, Number(params.get('words')) || 5000));
  const typewriter = params.get('typewriter') !== '0';
  const { doc, words } = sampleDoc(target);
  const readout = h('div', { class: 'boox-readout', role: 'status' });
  const mount = h('div', { class: 'editor-mount' });
  const page = h('article', { class: 'page' }, mount);
  const scroller = h('div', { class: 'writing' }, page);
  const layout = h('div', { class: 'layout boox', dataset: { kind: 'essay' } }, h('main', { class: 'main' }, scroller,
    h('footer', { class: 'statusbar' }, readout)));
  for (const [key, value] of Object.entries(BOOX_KIND.theme)) layout.style.setProperty(`--k-${key.replace(/_/g, '-')}`, value);
  root.appendChild(layout);

  const editor = new DocEditor({
    kind: BOOX_KIND,
    mount,
    scroller,
    content: doc,
    typewriter: () => typewriter,
  });
  const ready = performance.now() - t0;
  const samples: number[] = [];
  let pending: number | null = null;

  const show = () => {
    const sorted = [...samples].sort((a, b) => a - b);
    const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! : 0;
    readout.textContent = `${words.toLocaleString('en-GB')} words · editor ready in ${Math.round(ready)} ms` +
      (samples.length ? ` · keystroke: last ${Math.round(samples[samples.length - 1]!)} ms, avg ${Math.round(avg)} ms, p95 ${Math.round(p95)} ms (${samples.length})` : ' · type to measure keystroke latency') +
      ` · typewriter ${typewriter ? 'on' : 'off'}`;
    (window as unknown as { booxStats?: unknown }).booxStats = { words, ready, samples: [...samples], avg, p95 };
  };

  editor.editor.view.dom.addEventListener('keydown', () => {
    pending = performance.now();
  });
  editor.editor.on('update', () => {
    if (pending === null) return;
    const start = pending;
    pending = null;
    // Time until the frame after the change has been painted.
    requestAnimationFrame(() => {
      setTimeout(() => {
        samples.push(performance.now() - start);
        if (samples.length > 200) samples.shift();
        show();
      }, 0);
    });
  });
  show();
  editor.focusAt('end');
}

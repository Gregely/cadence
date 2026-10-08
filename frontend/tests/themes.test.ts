import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { allRules, colourLiterals, contrast, isTokenBlock, kindTokens, themeTokens } from './css';

const SRC = resolve(__dirname, '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('theme tokens', () => {
  it('finds colour literals and nothing else', () => {
    expect(colourLiterals('1px solid #e2dcd1')).toEqual(['#e2dcd1']);
    expect(colourLiterals('0 1px 0 rgba(0, 0, 0, 0.2)')).toEqual(['rgba(']);
    expect(colourLiterals('2px solid black')).toEqual(['black']);
    expect(colourLiterals('var(--line) transparent currentColor nowrap')).toEqual([]);
    expect(colourLiterals("url(\"data:image/svg+xml,%3Csvg fill='%23000'%3E\")")).toEqual([]);
  });

  it('writes colours only in token blocks', () => {
    const offenders = allRules()
      .filter((r) => !isTokenBlock(r))
      .flatMap((r) => r.decls
        .filter(([, v]) => colourLiterals(v).length)
        .map(([k, v]) => `${relative(SRC, r.file)}: ${r.selectors.join(', ')} { ${k}: ${v} }`));
    expect(offenders).toEqual([]);
  });

  it('has no colour literals in the code', () => {
    // The Boox test page carries a copy of a kind's registry entry, which is
    // data (kinds.py), not styling.
    const allowed = new Set(['boox.ts']);
    const offenders = sourceFiles(SRC)
      .filter((f) => !allowed.has(relative(SRC, f)))
      .flatMap((f) => readFileSync(f, 'utf8').split('\n')
        .map((line, i) => [line, i + 1] as const)
        .filter(([line]) => /['"`]#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(line))
        .map(([line, n]) => `${relative(SRC, f)}:${n}: ${line.trim()}`));
    expect(offenders).toEqual([]);
  });

  it('keeps the paper, dark and e-ink themes exactly as they were', async () => {
    const tokens = Object.fromEntries(['paper', 'dark', 'eink'].map((t) => [t, themeTokens(t)]));
    await expect(JSON.stringify(tokens, null, 2) + '\n').toMatchFileSnapshot('./fixtures/theme-tokens.json');
  });

  it('scopes every analogue rule to the analogue themes, so the others cannot change', () => {
    const rules = allRules().filter((r) => r.file.endsWith('analogue.css'));
    expect(rules.length).toBeGreaterThan(20);
    const loose = rules.flatMap((r) => r.selectors).filter((s) => !/^(:where\()?\[data-theme(\^='analogue'|='analogue(-dark)?')\]/.test(s));
    expect(loose).toEqual([]);
  });

  it('names a theme in base.css only to adjust that theme', () => {
    const named = allRules().filter((r) => r.file.endsWith('base.css') && !isTokenBlock(r) && r.selectors.some((s) => s.includes('data-theme')));
    for (const r of named) for (const s of r.selectors) expect(s).toMatch(/^\[data-theme='[a-z-]+'\]/);
  });
});

const NEW_THEMES = ['analogue'];

describe.each(NEW_THEMES)('%s: readable (WCAG AA)', (theme) => {
  const t = themeTokens(theme);
  const kinds = kindTokens(theme);
  const ratio = (fg: string, bg: string) => contrast(t[fg] ?? fg, t[bg] ?? bg);

  it('defines every colour token as a plain hex value', () => {
    for (const k of ['--bg', '--surface', '--raised', '--ink', '--muted', '--faint', '--dim', '--line', '--hover', '--current',
      '--selection', '--bar-bg', '--bar-ink', '--accent', '--page', '--well', '--field', '--face', '--face-hover', '--face-pressed', '--focus']) {
      expect(t[k], k).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  // Every surface text is drawn on: window, wells, fields, buttons, panels, rows.
  const surfaces = ['--bg', '--surface', '--raised', '--page', '--well', '--field', '--face', '--face-hover', '--face-pressed', '--hover', '--current', '--selection'];

  it.each(['--ink', '--muted', '--faint'])('%s text on every surface is at least 4.5:1', (fg) => {
    for (const bg of surfaces) expect(ratio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it('the writing page comfortably exceeds it', () => {
    expect(ratio('--ink', '--page')).toBeGreaterThanOrEqual(10);
  });

  it('dimmed text in focus mode is still readable on the page', () => {
    expect(ratio('--dim', '--page')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--ink', '--page') / ratio('--dim', '--page')).toBeGreaterThan(2); // and visibly dimmer
  });

  it('the format bar and messages read clearly', () => {
    expect(ratio('--bar-ink', '--bar-bg')).toBeGreaterThanOrEqual(4.5);
  });

  it('each kind keeps its own accent, readable on the page and panels', () => {
    expect(Object.keys(kinds).sort()).toEqual(['diary', 'essay', 'fiction', 'note', 'poetry']);
    const accents = [t['--accent']!, ...Object.values(kinds).map((k) => k['--accent']!)];
    expect(new Set(accents).size).toBe(accents.length);
    for (const a of accents) for (const bg of ['--page', '--raised', '--well']) expect(ratio(a, bg), `${a} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it('focus rings stand out from what they surround (3:1)', () => {
    for (const bg of ['--bg', '--page', '--raised', '--field', '--face']) expect(ratio('--focus', bg), bg).toBeGreaterThanOrEqual(3);
  });
});

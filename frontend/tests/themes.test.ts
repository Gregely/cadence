import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { allRules, colourLiterals, isTokenBlock, themeTokens } from './css';

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

  it('only styles a theme through rules scoped to it, apart from shared tokens', () => {
    // Rules outside the token blocks may name a theme only to adjust that theme.
    const scoped = allRules().filter((r) => !isTokenBlock(r) && r.selectors.some((s) => s.includes('data-theme')));
    for (const r of scoped) {
      for (const s of r.selectors) expect(s, `${r.selectors.join(', ')}`).toMatch(/^\[data-theme(\^)?='[a-z-]+'\]/);
    }
  });
});

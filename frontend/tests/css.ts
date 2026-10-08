import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** A style rule: its selectors, the at-rules around it, and its declarations. */
export interface Rule {
  selectors: string[];
  at: string[];
  decls: [string, string][];
  file: string;
}

export const STYLES = resolve(__dirname, '../src/styles');

export function styleFiles(): string[] {
  return readdirSync(STYLES).filter((f) => f.endsWith('.css')).map((f) => join(STYLES, f));
}

/** Enough of a CSS parser for our own stylesheets: rules, @media nesting, declarations. */
export function parseCss(source: string, file = ''): Rule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const walk = (text: string, at: string[]) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < text.length && depth; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
      }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith('@')) walk(body, [...at, prelude]);
      else {
        out.push({
          selectors: splitTop(prelude, ',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean),
          at,
          decls: splitTop(body, ';').map((d) => d.trim()).filter(Boolean).map((d) => {
            const k = d.indexOf(':');
            return [d.slice(0, k).trim(), d.slice(k + 1).trim()] as [string, string];
          }),
          file,
        });
      }
      i = j;
    }
  };
  walk(css, []);
  return out;
}

/** Split on a separator that is not inside brackets or quotes (data: URLs contain both). */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

export function allRules(): Rule[] {
  return styleFiles().flatMap((f) => parseCss(readFileSync(f, 'utf8'), f));
}

/** A block that only defines tokens for :root or a theme (the one place colours are written). */
export function isTokenBlock(rule: Rule): boolean {
  return rule.at.length === 0
    && rule.selectors.every((s) => /^(:root|\[data-theme='[a-z-]+'\](\[data-grain='[a-z]+'\])?( \.layout\[data-kind='[a-z]+'\])?)$/.test(s))
    && rule.decls.every(([k]) => k.startsWith('--') || k === 'color-scheme');
}

/** Tokens a theme defines, in source order (later blocks override earlier ones). */
export function themeTokens(theme: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of allRules()) {
    if (!isTokenBlock(rule)) continue;
    if (!rule.selectors.includes(`[data-theme='${theme}']`)) continue;
    for (const [k, v] of rule.decls) out[k] = v;
  }
  return out;
}

const NAMED = ['black', 'white', 'red', 'green', 'blue', 'gray', 'grey', 'silver', 'maroon', 'purple', 'navy', 'teal', 'olive',
  'yellow', 'orange', 'pink', 'brown', 'beige', 'ivory', 'tan', 'khaki', 'linen', 'wheat', 'gold', 'lime', 'aqua', 'fuchsia'];

/** Colour literals in a value: hex, rgb()/hsl() and the common named colours. */
export function colourLiterals(value: string): string[] {
  const v = value.replace(/url\((['"]?)data:[^)]*\1\)/g, 'url()');
  const found: string[] = v.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/g) ?? [];
  for (const name of NAMED) if (new RegExp(`(^|[\\s,(])${name}($|[\\s,)])`, 'i').test(v)) found.push(name);
  return found;
}

/** Per-kind tokens a theme sets on .layout[data-kind=...]. */
export function kindTokens(theme: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const rule of allRules()) {
    if (!isTokenBlock(rule)) continue;
    for (const s of rule.selectors) {
      const m = s.match(new RegExp(`^\\[data-theme='${theme}'\\] \\.layout\\[data-kind='([a-z]+)'\\]$`));
      if (m) out[m[1]!] = { ...out[m[1]!], ...Object.fromEntries(rule.decls) };
    }
  }
  return out;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2 contrast ratio between two hex colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

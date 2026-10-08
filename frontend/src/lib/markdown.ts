/** Minimal ProseMirror JSON -> Markdown, used for the diary's decrypted export (done in the browser). */
interface N {
  type?: string;
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
  content?: N[];
}

const esc = (t: string) => t.replace(/([\\`*_[\]<>|])/g, '\\$1');

function inline(nodes: N[] = []): string {
  return nodes.map((n) => {
    if (n.type === 'hardBreak') return '\\\n';
    if (n.type === 'footnote') return ` (${esc(String(n.attrs?.text ?? ''))})`;
    if (n.type !== 'text') return '';
    let t = esc(n.text ?? '');
    const core = t.trim();
    if (!core) return t;
    const lead = t.slice(0, t.length - t.trimStart().length);
    const trail = t.slice(t.trimEnd().length);
    let c = core;
    const marks = new Set((n.marks ?? []).map((m) => m.type));
    if (marks.has('italic')) c = `*${c}*`;
    if (marks.has('bold')) c = `**${c}**`;
    t = lead + c + trail;
    return t;
  }).join('');
}

export function toMarkdown(doc: N, headingShift = 0): string {
  const out: string[] = [];
  for (const b of doc.content ?? []) {
    if (b.type === 'paragraph') out.push(inline(b.content));
    else if (b.type === 'heading') out.push(`${'#'.repeat(Math.min(6, Number(b.attrs?.level ?? 2) + headingShift))} ${inline(b.content)}`);
    else if (b.type === 'blockquote') out.push(toMarkdown(b).split('\n').map((l) => `> ${l}`).join('\n'));
    else if (b.type === 'sectionBreak') out.push('* * *');
    else if (b.type === 'bulletList') out.push((b.content ?? []).map((li) => `- ${toMarkdown(li)}`).join('\n'));
  }
  return out.filter((x) => x.trim()).join('\n\n');
}

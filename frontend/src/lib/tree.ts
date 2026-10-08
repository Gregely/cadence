import type { DocSummary, Folder } from '../types';

export const MAX_DEPTH = 4;

export interface FolderNode {
  type: 'folder';
  id: number;
  parent: number | null;
  depth: number; // 1 for a top-level folder
  folder: Folder;
  folders: FolderNode[];
  docs: DocNode[];
}

export interface DocNode {
  type: 'doc';
  id: number;
  parent: number | null;
  depth: number; // depth of the containing folder (0 at the root)
  doc: DocSummary;
}

export type Node = FolderNode | DocNode;

export interface Root {
  folders: FolderNode[];
  docs: DocNode[];
  byFolder: Map<number, FolderNode>;
  byDoc: Map<number, DocNode>;
}

export type DocOrder = 'manual' | 'newest';

const byOrder = <T extends { sort_order: number; id: number }>(a: T, b: T) =>
  a.sort_order - b.sort_order || a.id - b.id;
const byNewest = (a: DocSummary, b: DocSummary) =>
  (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id);

export function buildTree(folders: Folder[], docs: DocSummary[], order: DocOrder = 'manual'): Root {
  const byFolder = new Map<number, FolderNode>();
  const byDoc = new Map<number, DocNode>();
  for (const f of folders) {
    byFolder.set(f.id, { type: 'folder', id: f.id, parent: f.parent_id, depth: 0, folder: f, folders: [], docs: [] });
  }
  const root: Root = { folders: [], docs: [], byFolder, byDoc };
  for (const f of [...folders].sort(byOrder)) {
    const node = byFolder.get(f.id)!;
    const parent = f.parent_id !== null ? byFolder.get(f.parent_id) : undefined;
    if (parent) parent.folders.push(node);
    else {
      node.parent = null;
      root.folders.push(node);
    }
  }
  const setDepth = (nodes: FolderNode[], depth: number) => {
    for (const n of nodes) {
      n.depth = depth;
      setDepth(n.folders, depth + 1);
    }
  };
  setDepth(root.folders, 1);
  const sorted = [...docs].sort(order === 'manual' ? byOrder : byNewest);
  for (const d of sorted) {
    const parent = d.folder_id !== null ? byFolder.get(d.folder_id) : undefined;
    const node: DocNode = { type: 'doc', id: d.id, parent: parent ? parent.id : null, depth: parent ? parent.depth : 0, doc: d };
    byDoc.set(d.id, node);
    if (parent) parent.docs.push(node);
    else root.docs.push(node);
  }
  return root;
}

export interface Row {
  node: Node;
  level: number; // indentation level for display
  index: number; // position among same-type siblings
}

/** Visible rows in display order: each folder's subfolders, then its documents. */
export function flatten(root: Root, collapsed: Set<number>): Row[] {
  const rows: Row[] = [];
  const walk = (folders: FolderNode[], docs: DocNode[], level: number) => {
    folders.forEach((f, index) => {
      rows.push({ node: f, level, index });
      if (!collapsed.has(f.id)) walk(f.folders, f.docs, level + 1);
    });
    docs.forEach((d, index) => rows.push({ node: d, level, index }));
  };
  walk(root.folders, root.docs, 0);
  return rows;
}

export function siblings(root: Root, node: Node): Node[] {
  const parent = node.parent !== null ? root.byFolder.get(node.parent) : undefined;
  if (node.type === 'folder') return parent ? parent.folders : root.folders;
  return parent ? parent.docs : root.docs;
}

export function subtreeHeight(node: FolderNode): number {
  return 1 + Math.max(0, ...node.folders.map(subtreeHeight));
}

export function isDescendant(root: Root, folderId: number, maybeAncestor: number): boolean {
  let cur = root.byFolder.get(folderId);
  while (cur) {
    if (cur.id === maybeAncestor) return true;
    cur = cur.parent !== null ? root.byFolder.get(cur.parent) : undefined;
  }
  return false;
}

export interface Move {
  type: 'folder' | 'doc';
  id: number;
  parent: number | null;
  index?: number;
}

export function moveUp(root: Root, node: Node): Move | null {
  const sibs = siblings(root, node);
  const i = sibs.findIndex((s) => s.id === node.id);
  if (i <= 0) return null;
  return { type: node.type, id: node.id, parent: node.parent, index: i - 1 };
}

export function moveDown(root: Root, node: Node): Move | null {
  const sibs = siblings(root, node);
  const i = sibs.findIndex((s) => s.id === node.id);
  if (i < 0 || i >= sibs.length - 1) return null;
  return { type: node.type, id: node.id, parent: node.parent, index: i + 1 };
}

/** Indent: into the folder just above, at the same level. */
export function indent(root: Root, node: Node): Move | null {
  const parent = node.parent !== null ? root.byFolder.get(node.parent) : undefined;
  const folders = parent ? parent.folders : root.folders;
  if (node.type === 'folder') {
    const i = folders.findIndex((f) => f.id === node.id);
    if (i <= 0) return null;
    const target = folders[i - 1]!;
    if (target.depth + subtreeHeight(node) > MAX_DEPTH) return null;
    return { type: 'folder', id: node.id, parent: target.id };
  }
  const target = folders[folders.length - 1];
  if (!target) return null;
  return { type: 'doc', id: node.id, parent: target.id };
}

/** Outdent: out of the containing folder, next to it. */
export function outdent(root: Root, node: Node): Move | null {
  if (node.parent === null) return null;
  const parent = root.byFolder.get(node.parent);
  if (!parent) return null;
  if (node.type === 'folder') {
    const grand = parent.parent !== null ? root.byFolder.get(parent.parent) : undefined;
    const list = grand ? grand.folders : root.folders;
    const i = list.findIndex((f) => f.id === parent.id);
    return { type: 'folder', id: node.id, parent: parent.parent, index: i + 1 };
  }
  return { type: 'doc', id: node.id, parent: parent.parent };
}

export type DropPosition = 'before' | 'after' | 'inside';

/**
 * Where does dropping `dragged` onto `target` at `position` put it?
 * Returns null for drops that are not allowed (cycles, too deep).
 */
export function dropMove(root: Root, dragged: Node, target: Node | null, position: DropPosition): Move | null {
  let parent: number | null;
  let index: number | undefined;
  if (target === null) {
    parent = null;
    index = undefined;
  } else if (position === 'inside' && target.type === 'folder') {
    parent = target.id;
    index = dragged.type === 'folder' ? target.folders.length : target.docs.length;
  } else {
    parent = target.parent;
    if (target.type === dragged.type) {
      const sibs = siblings(root, target).filter((s) => s.id !== dragged.id);
      const i = sibs.findIndex((s) => s.id === target.id);
      index = position === 'after' ? i + 1 : i;
    } else if (dragged.type === 'doc') {
      // A document dropped next to a folder goes first among that level's documents.
      index = 0;
    } else {
      // A folder dropped next to a document goes last among that level's folders.
      index = undefined;
    }
  }
  if (dragged.type === 'folder') {
    if (parent !== null && isDescendant(root, parent, dragged.id)) return null;
    const parentDepth = parent !== null ? root.byFolder.get(parent)?.depth ?? 0 : 0;
    if (parentDepth + subtreeHeight(dragged as FolderNode) > MAX_DEPTH) return null;
  }
  return { type: dragged.type, id: dragged.id, parent, index };
}

export interface MonthGroup {
  year: number;
  month: number; // 0-11
  docs: DocSummary[];
}

/** Diary-style grouping by creation month, newest first. */
export function groupByMonth(docs: DocSummary[]): MonthGroup[] {
  const groups = new Map<string, MonthGroup>();
  for (const d of [...docs].sort(byNewest)) {
    const dt = new Date(d.created_at);
    const key = `${dt.getFullYear()}-${dt.getMonth()}`;
    let g = groups.get(key);
    if (!g) {
      g = { year: dt.getFullYear(), month: dt.getMonth(), docs: [] };
      groups.set(key, g);
    }
    g.docs.push(d);
  }
  return [...groups.values()];
}

/** Path of folder names from the root to a folder. */
export function folderPath(root: Root, folderId: number | null): FolderNode[] {
  const out: FolderNode[] = [];
  let cur = folderId !== null ? root.byFolder.get(folderId) : undefined;
  while (cur) {
    out.unshift(cur);
    cur = cur.parent !== null ? root.byFolder.get(cur.parent) : undefined;
  }
  return out;
}

/** All documents under a folder, depth-first in display order. */
export function docsInFolder(node: FolderNode): DocSummary[] {
  return [...node.folders.flatMap(docsInFolder), ...node.docs.map((d) => d.doc)];
}

import { describe, expect, it } from 'vitest';

import {
  buildTree, dropMove, flatten, groupByMonth, indent, moveDown, moveUp, outdent,
} from '../src/lib/tree';
import type { DocSummary, Folder } from '../src/types';

const f = (id: number, parent: number | null, sort: number, name = `F${id}`): Folder => ({
  id, kind: 'essay', parent_id: parent, name, sort_order: sort, created_at: '', updated_at: '',
});
const d = (id: number, folder: number | null, sort: number, created = '2026-01-01T00:00:00Z'): DocSummary => ({
  id, kind: 'essay', folder_id: folder, sort_order: sort, title: `D${id}`, status: null, word_target: null,
  created_at: created, updated_at: created, last_opened_at: null, role: null,
});

// Root: A(1) [ B(2) [ C(3) ] , docs 10, 11 ], E(5); docs 20, 21 at root
const folders = [f(1, null, 0), f(2, 1, 0), f(3, 2, 0), f(5, null, 1)];
const docs = [d(10, 1, 0), d(11, 1, 1), d(20, null, 0), d(21, null, 1)];

describe('tree', () => {
  const root = buildTree(folders, docs);

  it('builds depths and display order', () => {
    expect(root.byFolder.get(3)!.depth).toBe(3);
    const rows = flatten(root, new Set());
    expect(rows.map((r) => `${r.node.type[0]}${r.node.id}@${r.level}`)).toEqual([
      'f1@0', 'f2@1', 'f3@2', 'd10@1', 'd11@1', 'f5@0', 'd20@0', 'd21@0',
    ]);
    expect(flatten(root, new Set([1])).map((r) => r.node.id)).toEqual([1, 5, 20, 21]);
  });

  it('moves up and down among same-type siblings', () => {
    expect(moveUp(root, root.byDoc.get(11)!)).toEqual({ type: 'doc', id: 11, parent: 1, index: 0 });
    expect(moveUp(root, root.byDoc.get(10)!)).toBeNull();
    expect(moveDown(root, root.byDoc.get(11)!)).toBeNull();
    expect(moveDown(root, root.byFolder.get(1)!)).toEqual({ type: 'folder', id: 1, parent: null, index: 1 });
  });

  it('indents into the folder above and outdents next to the parent', () => {
    expect(indent(root, root.byFolder.get(5)!)).toEqual({ type: 'folder', id: 5, parent: 1 });
    expect(indent(root, root.byDoc.get(20)!)).toEqual({ type: 'doc', id: 20, parent: 5 });
    expect(outdent(root, root.byFolder.get(2)!)).toEqual({ type: 'folder', id: 2, parent: null, index: 1 });
    expect(outdent(root, root.byDoc.get(10)!)).toEqual({ type: 'doc', id: 10, parent: null });
    expect(outdent(root, root.byDoc.get(20)!)).toBeNull();
  });

  it('refuses indents that would exceed depth 4', () => {
    // E(5) with a child and grandchild has height 3; under A (depth 1) -> 4: ok.
    const deeper = buildTree([...folders, f(6, 5, 0), f(7, 6, 0)], docs);
    expect(indent(deeper, deeper.byFolder.get(5)!)).not.toBeNull();
    // Give E height 4: indenting under A would make depth 5.
    const tooDeep = buildTree([...folders, f(6, 5, 0), f(7, 6, 0), f(8, 7, 0)], docs);
    expect(indent(tooDeep, tooDeep.byFolder.get(5)!)).toBeNull();
  });

  it('computes drop targets and rejects cycles', () => {
    const a = root.byFolder.get(1)!;
    const c = root.byFolder.get(3)!;
    expect(dropMove(root, a, c, 'inside')).toBeNull(); // into own descendant
    expect(dropMove(root, root.byDoc.get(20)!, c, 'inside')).toEqual({ type: 'doc', id: 20, parent: 3, index: 0 });
    expect(dropMove(root, root.byDoc.get(21)!, root.byDoc.get(20)!, 'before')).toEqual({ type: 'doc', id: 21, parent: null, index: 0 });
    expect(dropMove(root, root.byDoc.get(10)!, root.byDoc.get(21)!, 'after')).toEqual({ type: 'doc', id: 10, parent: null, index: 2 });
    expect(dropMove(root, root.byFolder.get(5)!, null, 'after')).toEqual({ type: 'folder', id: 5, parent: null, index: undefined });
  });

  it('groups by month newest first', () => {
    const g = groupByMonth([
      d(1, null, 0, '2026-09-03T10:00:00Z'), d(2, null, 0, '2026-10-01T10:00:00Z'), d(3, null, 0, '2026-10-05T10:00:00Z'),
      d(4, null, 0, '2025-12-24T10:00:00Z'),
    ]);
    expect(g.map((x) => `${x.year}-${x.month}:${x.docs.map((y) => y.id).join(',')}`)).toEqual([
      '2026-9:3,2', '2026-8:1', '2025-11:4',
    ]);
  });
});

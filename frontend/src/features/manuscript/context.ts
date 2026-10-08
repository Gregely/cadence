import type { App } from '../../app';
import { type FolderNode, folderPath } from '../../lib/tree';

/** Folders from the project down to where the writer is (folder view or open document). */
export function contextFolders(app: App, start?: FolderNode | null): FolderNode[] {
  const root = app.sidebar.root;
  if (!root) return [];
  if (start) return folderPath(root, start.id);
  if (app.view) return folderPath(root, app.view.folder.id);
  const id = app.activeDocId();
  const doc = id !== null ? app.tree.documents.find((d) => d.id === id) : undefined;
  return doc ? folderPath(root, doc.folder_id) : [];
}

/** The project: the top-level folder of the current context. */
export function contextProject(app: App, start?: FolderNode | null): FolderNode | null {
  return contextFolders(app, start)[0] ?? null;
}

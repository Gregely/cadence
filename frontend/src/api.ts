import type {
  DocFull, DocSummary, Folder, InboxItem, KindDef, SearchHit, Session, Snapshot, Tree,
} from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class OfflineError extends Error {
  constructor() {
    super('The server could not be reached.');
  }
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
    });
  } catch {
    throw new OfflineError();
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = (data && typeof data === 'object' && 'detail' in data) ? String((data as { detail: unknown }).detail) : res.statusText;
    throw new ApiError(res.status, detail);
  }
  return data as T;
}

const get = <T>(p: string) => request<T>('GET', p);
const post = <T>(p: string, b: unknown = {}) => request<T>('POST', p, b);
const patch = <T>(p: string, b: unknown) => request<T>('PATCH', p, b);
const del = <T>(p: string) => request<T>('DELETE', p);
const q = (params: Record<string, string | number | boolean | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const api = {
  kinds: () => get<KindDef[]>('/api/kinds'),
  state: () => get<{ last_document: { id: number; kind: string } | null }>('/api/state'),
  tree: (kind: string) => get<Tree>(`/api/kinds/${kind}/tree`),
  stream: (kind: string, offset = 0, limit = 50) =>
    get<{ documents: DocFull[]; more: boolean }>(`/api/kinds/${kind}/stream${q({ offset, limit })}`),

  createFolder: (kind: string, name: string, parent_id: number | null, index?: number) =>
    post<Folder>('/api/folders', { kind, name, parent_id, index }),
  renameFolder: (id: number, name: string) => patch<Folder>(`/api/folders/${id}`, { name }),
  moveFolder: (id: number, parent_id: number | null, index?: number) =>
    post<Folder>(`/api/folders/${id}/move`, { parent_id, index }),
  deleteFolder: (id: number) => del<unknown>(`/api/folders/${id}`),

  createDocument: (body: Record<string, unknown>) => post<DocFull>('/api/documents', body),
  getDocument: (id: number) => get<DocFull>(`/api/documents/${id}`),
  openDocument: (id: number) => post<DocFull>(`/api/documents/${id}/open`),
  updateDocument: (id: number, body: Record<string, unknown>, init?: RequestInit) =>
    request<DocFull>('PATCH', `/api/documents/${id}`, body, init),
  moveDocument: (id: number, folder_id: number | null, index?: number) =>
    post<DocSummary>(`/api/documents/${id}/move`, { folder_id, index }),
  deleteDocument: (id: number) => del<unknown>(`/api/documents/${id}`),

  snapshots: (docId: number) => get<Snapshot[]>(`/api/documents/${docId}/snapshots`),
  createSnapshot: (docId: number, label?: string, content_json?: string) =>
    post<Snapshot>(`/api/documents/${docId}/snapshots`, { label, content_json }),
  snapshot: (id: number) => get<Snapshot>(`/api/snapshots/${id}`),
  renameSnapshot: (id: number, label: string) => patch<Snapshot>(`/api/snapshots/${id}`, { label }),
  deleteSnapshot: (id: number) => del<void>(`/api/snapshots/${id}`),
  restoreSnapshot: (id: number) => post<DocFull>(`/api/snapshots/${id}/restore`),

  capture: (text: string, from_kind: string | null) => post<InboxItem>('/api/inbox', { text, from_kind }),
  inbox: (include_handled = false) => get<InboxItem[]>(`/api/inbox${q({ include_handled })}`),
  updateInbox: (id: number, body: { text?: string; handled?: boolean }) => patch<InboxItem>(`/api/inbox/${id}`, body),
  deleteInbox: (id: number) => del<void>(`/api/inbox/${id}`),
  inboxToDocument: (id: number, body: { kind: string; folder_id?: number | null; document_id?: number }) =>
    post<DocFull>(`/api/inbox/${id}/to-document`, body),

  startSession: (document_id: number, words_start: number) =>
    post<Session>('/api/sessions', { document_id, words_start }),
  checkpoint: (id: number, feeling: 'flowing' | 'fighting') => post<Session>(`/api/sessions/${id}/checkpoint`, { feeling }),
  endSession: (id: number, body: { words_end?: number; reentry_note?: string }, keepalive = false) =>
    request<Session>('POST', `/api/sessions/${id}/end`, body, keepalive ? { keepalive: true } : undefined),

  trash: (kind?: string) => get<{ folders: Folder[]; documents: DocSummary[]; purge_after_days: number }>(`/api/trash${q({ kind })}`),
  restoreDocument: (id: number) => post<DocSummary>(`/api/trash/documents/${id}/restore`),
  restoreFolder: (id: number) => post<Folder>(`/api/trash/folders/${id}/restore`),
  purgeDocument: (id: number) => del<void>(`/api/trash/documents/${id}`),
  purgeFolder: (id: number) => del<void>(`/api/trash/folders/${id}`),

  search: (query: string, kind: string | null, allKinds = false, limit = 30) =>
    get<SearchHit[]>(`/api/search${q({ q: query, kind: allKinds ? undefined : kind, all_kinds: allKinds || undefined, limit })}`),
};

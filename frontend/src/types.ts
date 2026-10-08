export type ListView = 'tree' | 'stream' | 'ordered' | 'by-month';
export type Prominence = 'off' | 'normal' | 'prominent';

export interface KindTools {
  research_pane: boolean;
  session_timer: boolean;
  word_target: boolean;
  status: boolean;
  word_count: boolean;
  snapshots: Prominence;
  reentry: Prominence;
  combined_view: boolean;
  draft_mode: boolean;
  next_document: boolean;
  inspector: boolean;
  compile: boolean;
  draft_sets: boolean;
  todo_markers: boolean;
  split_view: boolean;
  project_search: boolean;
  reading_mode: boolean;
  timeline: boolean;
  forward_only: boolean;
}

export interface RoleDef {
  id: string;
  label: string;
  /** In the manuscript flow, word counts and compile. */
  manuscript: boolean;
}

export interface Beat {
  text: string;
  done: boolean;
}

export interface KindDef {
  id: string;
  label: string;
  extensions: string[];
  theme: Record<string, string>;
  tools: KindTools;
  searchable: boolean;
  exportable: boolean;
  encrypted: boolean;
  folders_enabled: boolean;
  list_view: ListView;
  statuses: string[];
  title_mode: 'required' | 'optional' | 'generated';
  placeholder: string;
  folder_label: string;
  item_label: string;
  capture_allowed: boolean;
  sessions_allowed: boolean;
  roles: RoleDef[];
  default_role: string | null;
  meta_fields: string[];
  status_symbols: Record<string, string>;
}

export interface Folder {
  id: number;
  kind: string;
  parent_id: number | null;
  name: string;
  sort_order: number;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
  contains?: { folders: number; documents: number };
}

export interface DocSummary {
  id: number;
  kind: string;
  folder_id: number | null;
  sort_order: number;
  title: string;
  status: string | null;
  word_target: number | null;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  deleted_at?: string | null;
  excerpt?: string;
  words?: number;
  role: string | null;
  synopsis?: string | null;
  pov?: string | null;
  story_date?: string | null;
}

export interface DocFull extends DocSummary {
  content_json: string;
  meta: Record<string, unknown>;
  plain_text?: string;
  reentry_note?: string | null;
  reentry_note_at?: string | null;
  folder_path?: { id: number; name: string }[];
}

export interface Tree {
  kind: string;
  folders: Folder[];
  documents: DocSummary[];
  last_document_id: number | null;
}

export interface Snapshot {
  id: number;
  document_id: number;
  label: string;
  created_at: string;
  content_json?: string;
}

export interface InboxItem {
  id: number;
  text: string;
  from_kind: string | null;
  created_at: string;
  handled_at: string | null;
}

export interface Session {
  id: number;
  document_id: number;
  started_at: string;
  ended_at: string | null;
  words_start: number | null;
  words_end: number | null;
  reentry_note: string | null;
  checkpoints: { at: string; feeling: 'flowing' | 'fighting' }[];
}

export interface SearchHit {
  id: number;
  kind: string;
  title: string;
  title_hit: string;
  status: string | null;
  updated_at: string;
  snippet: string;
  folder_path: string[];
  folder_id: number | null;
  role?: string | null;
}

export type PMNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
};

export interface Source {
  id: number;
  title: string;
  author: string;
  url: string;
  published: string;
  notes: string;
  clip_count?: number;
  clips?: Clip[];
}

export interface Clip {
  id: number;
  source_id: number;
  quote: string;
  page: string;
  note: string;
  created_at: string;
  document_ids: number[];
  source?: Source;
}

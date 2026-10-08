"""The fixed registry of document kinds.

A kind is defined entirely by its entry here. The rest of the backend and the
frontend read these fields and never switch on a kind's id, so a new kind is
added by calling ``register(Kind(...))`` below and nothing else.

Extension names are the vocabulary shared with the frontend editor and the
exporters. Structural ones map to ProseMirror node/mark types (see
``content.EXTENSION_TYPES``); behavioural ones (typography, poetryLines,
indent) only change editing behaviour.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

ListView = Literal["tree", "stream", "ordered", "by-month"]
Prominence = Literal["off", "normal", "prominent"]
TitleMode = Literal["required", "optional", "generated"]


@dataclass(frozen=True)
class Tools:
    research_pane: bool = False
    session_timer: bool = False
    word_target: bool = False
    status: bool = False
    word_count: bool = True
    snapshots: Prominence = "normal"
    reentry: Prominence = "normal"
    # Manuscript tools. All optional and off unless a kind turns them on.
    combined_view: bool = False  # clicking a folder shows every document in it
    draft_mode: bool = False  # hotkey: only the text, the word count and "next"
    next_document: bool = False  # "next scene": new document right below this one
    inspector: bool = False  # per-document details panel (status, synopsis, ...)
    compile: bool = False  # folder -> manuscript (.docx/.md/.html)
    draft_sets: bool = False  # named whole-project snapshots
    todo_markers: bool = False  # [[...]] markers, collected per project
    split_view: bool = False  # open another document beside this one
    project_search: bool = False  # search scoped to the top-level folder
    reading_mode: bool = False  # paginated, read-only view
    timeline: bool = False  # documents laid out by in-story date
    forward_only: bool = False  # optional: earlier paragraphs read-only


@dataclass(frozen=True)
class Role:
    """What a document is within its kind. The first role is the default.

    Documents whose role is not ``manuscript`` (notes about characters,
    settings, research) stay out of the combined view's text flow, word
    counts and compile.
    """

    id: str
    label: str
    manuscript: bool = True


@dataclass(frozen=True)
class Kind:
    id: str
    label: str
    extensions: tuple[str, ...]
    theme: dict[str, str]
    tools: Tools
    searchable: bool
    exportable: bool
    encrypted: bool
    folders_enabled: bool
    list_view: ListView
    statuses: tuple[str, ...] = ()
    title_mode: TitleMode = "required"
    # Placeholder shown in an empty editor. Kept neutral: no nagging.
    placeholder: str = ""
    # Label for a folder in this kind ("Folder", "Project", "Collection").
    folder_label: str = "Folder"
    # Label for a document in this kind ("Essay", "Scene", "Entry").
    item_label: str = "Document"
    # Roles a document can have; empty for kinds that do not use roles.
    roles: tuple[Role, ...] = ()
    # Optional per-document details kept in meta (validated in library.py):
    # synopsis, pov, story_date, beats.
    meta_fields: tuple[str, ...] = ()
    # A shape for each status, so status never depends on colour.
    status_symbols: dict[str, str] = field(default_factory=dict)

    @property
    def default_role(self) -> str | None:
        return self.roles[0].id if self.roles else None

    def role(self, role_id: str | None) -> Role | None:
        return next((r for r in self.roles if r.id == role_id), None)

    def manuscript_roles(self) -> set[str]:
        return {r.id for r in self.roles if r.manuscript}

    @property
    def capture_allowed(self) -> bool:
        # Capture writes plain text to the inbox, which an encrypted kind
        # must never do.
        return not self.encrypted

    @property
    def sessions_allowed(self) -> bool:
        # Sessions store word counts and a plain-text re-entry note.
        return not self.encrypted and self.tools.reentry != "off"

    def to_public(self) -> dict:
        data = asdict(self)
        data["extensions"] = list(self.extensions)
        data["statuses"] = list(self.statuses)
        data["roles"] = [asdict(r) for r in self.roles]
        data["meta_fields"] = list(self.meta_fields)
        data["default_role"] = self.default_role
        data["capture_allowed"] = self.capture_allowed
        data["sessions_allowed"] = self.sessions_allowed
        return data


KINDS: dict[str, Kind] = {}

MAX_FOLDER_DEPTH = 4


def register(kind: Kind) -> Kind:
    if kind.id in KINDS:
        raise ValueError(f"kind {kind.id!r} is already registered")
    if not kind.id.isidentifier():
        raise ValueError("kind id must be a simple identifier")
    KINDS[kind.id] = kind
    return kind


def unregister(kind_id: str) -> None:
    """Only for tests that add a temporary kind."""
    KINDS.pop(kind_id, None)


def get_kind(kind_id: str) -> Kind | None:
    return KINDS.get(kind_id)


def all_kinds() -> list[Kind]:
    return list(KINDS.values())


def searchable_kind_ids() -> list[str]:
    return [k.id for k in KINDS.values() if k.searchable]


# Typography: system font stacks plus Literata, which is bundled with the
# frontend (no font is fetched from the network).
SERIF = "'Literata', 'Iowan Old Style', 'Charter', 'Georgia', serif"
BOOK = "'Iowan Old Style', 'Palatino Linotype', 'Palatino', 'Book Antiqua', 'Georgia', serif"
SANS = "system-ui, -apple-system, 'Segoe UI', 'Noto Sans', 'Helvetica Neue', Arial, sans-serif"


register(
    Kind(
        id="essay",
        label="Essays",
        extensions=(
            "typography",
            "heading:2,3",
            "bold",
            "italic",
            "link",
            "blockquote",
            "footnote",
            "citation",
            "sectionBreak",
            "hardBreak",
        ),
        theme={
            "font_body": SERIF,
            "font_heading": SERIF,
            "font_size": "1.125rem",
            "line_height": "1.65",
            "measure": "38rem",
            "paragraph_gap": "0.9em",
            "text_indent": "0",
            "accent": "#8a5a2b",
            "accent_dark": "#d9a46c",
        },
        tools=Tools(research_pane=True, session_timer=True, word_target=True, status=True),
        searchable=True,
        exportable=True,
        encrypted=False,
        folders_enabled=True,
        list_view="tree",
        statuses=("idea", "draft", "revising", "done"),
        folder_label="Folder",
        item_label="Essay",
    )
)

register(
    Kind(
        id="note",
        label="Notes",
        extensions=(
            "typography",
            "bold",
            "italic",
            "link",
            "bulletList",
            "hardBreak",
        ),
        theme={
            "font_body": SANS,
            "font_heading": SANS,
            "font_size": "1rem",
            "line_height": "1.55",
            "measure": "40rem",
            "paragraph_gap": "0.6em",
            "text_indent": "0",
            "accent": "#3d6b5a",
            "accent_dark": "#8cc7b0",
        },
        tools=Tools(word_count=True, snapshots="normal", reentry="off"),
        searchable=True,
        exportable=True,
        encrypted=False,
        folders_enabled=True,
        list_view="stream",
        title_mode="optional",
        folder_label="Folder",
        item_label="Note",
    )
)

register(
    Kind(
        id="poetry",
        label="Poetry",
        extensions=("typography", "italic", "hardBreak", "poetryLines", "indent"),
        theme={
            "font_body": BOOK,
            "font_heading": BOOK,
            "font_size": "1.2rem",
            "line_height": "1.9",
            "measure": "34rem",
            "paragraph_gap": "1.9em",
            "text_indent": "0",
            "accent": "#5b4f86",
            "accent_dark": "#b4a8e6",
        },
        tools=Tools(snapshots="prominent", session_timer=True),
        searchable=True,
        exportable=True,
        encrypted=False,
        folders_enabled=True,
        list_view="tree",
        folder_label="Collection",
        item_label="Poem",
    )
)

register(
    Kind(
        id="diary",
        label="Diary",
        extensions=("typography", "bold", "italic", "hardBreak"),
        theme={
            "font_body": BOOK,
            "font_heading": BOOK,
            "font_size": "1.1rem",
            "line_height": "1.7",
            "measure": "36rem",
            "paragraph_gap": "0.9em",
            "text_indent": "0",
            "accent": "#7a4a5a",
            "accent_dark": "#d6a0b2",
        },
        tools=Tools(word_count=False, snapshots="normal", reentry="off"),
        searchable=False,
        exportable=False,
        encrypted=True,
        folders_enabled=False,
        list_view="by-month",
        title_mode="generated",
        item_label="Entry",
    )
)

register(
    Kind(
        id="fiction",
        label="Fiction",
        extensions=("typography", "bold", "italic", "sectionBreak", "hardBreak", "todoMarkers", "forwardOnly"),
        theme={
            "font_body": SERIF,
            "font_heading": SERIF,
            "font_size": "1.125rem",
            "line_height": "1.7",
            "measure": "36rem",
            "paragraph_gap": "0",
            "text_indent": "1.5em",
            "accent": "#2f5d7c",
            "accent_dark": "#8fbfdf",
        },
        tools=Tools(
            session_timer=True,
            word_target=True,
            reentry="prominent",
            status=True,
            combined_view=True,
            draft_mode=True,
            next_document=True,
            inspector=True,
            compile=True,
            draft_sets=True,
            todo_markers=True,
            split_view=True,
            project_search=True,
            reading_mode=True,
            timeline=True,
            forward_only=True,
        ),
        statuses=("stub", "drafted", "revised", "done"),
        status_symbols={"stub": "□", "drafted": "◧", "revised": "▣", "done": "■"},
        roles=(Role("scene", "Scene", manuscript=True), Role("misc", "Misc note", manuscript=False)),
        meta_fields=("synopsis", "pov", "story_date", "beats"),
        searchable=True,
        exportable=True,
        encrypted=False,
        folders_enabled=True,
        list_view="ordered",
        folder_label="Project",
        item_label="Scene",
    )
)

"""Manuscripts: compile a folder of scenes, and collect TODO markers.

Used by kinds whose registry entry turns on ``tools.compile`` or
``tools.todo_markers`` (fiction). Only documents whose role is a manuscript
role are compiled or counted; ``[[...]]`` markers are left out of compiled
output.
"""

from __future__ import annotations

import io
import json
import re
import sqlite3
from typing import Any, Iterator

from . import content
from .errors import Forbidden, Invalid
from .export import Export, HtmlRenderer, MarkdownRenderer, Part, Section, _children, _marks, safe_filename
from .kinds import Kind
from .library import doc_role, folder_path, folder_row, require_kind

# [[fix: tighten this]] or [[check the date]]: any text, on one line.
TODO = re.compile(r"\[\[([^\[\]\n]+?)\]\]")
SCENE_BREAK = "#"


def project_root(conn: sqlite3.Connection, folder_id: int) -> sqlite3.Row:
    """The top-level folder a folder belongs to (the project)."""
    row = folder_row(conn, folder_id)
    seen = {row["id"]}
    while row["parent_id"] is not None:
        parent = conn.execute("SELECT * FROM folders WHERE id = ?", (row["parent_id"],)).fetchone()
        if parent is None or parent["deleted_at"] is not None or parent["id"] in seen:
            break
        seen.add(parent["id"])
        row = parent
    return row


def _tool(kind: Kind, name: str) -> None:
    if not getattr(kind.tools, name) or kind.encrypted:
        raise Forbidden(f"{kind.label} has no {name.replace('_', ' ')}")


def walk(conn: sqlite3.Connection, folder_id: int, depth: int = 0) -> Iterator[tuple[str, int, Any]]:
    """('folder', depth, row) and ('doc', depth, row) in library order:
    subfolders first, then documents, as in the sidebar."""
    for sub in conn.execute(
        "SELECT * FROM folders WHERE parent_id = ? AND deleted_at IS NULL ORDER BY sort_order, id", (folder_id,)
    ).fetchall():
        yield ("folder", depth, sub)
        yield from walk(conn, sub["id"], depth + 1)
    for doc in conn.execute(
        "SELECT * FROM documents WHERE folder_id = ? AND deleted_at IS NULL ORDER BY sort_order, id", (folder_id,)
    ).fetchall():
        yield ("doc", depth, doc)


def in_manuscript(kind: Kind, row: sqlite3.Row) -> bool:
    if not kind.roles:
        return True
    return doc_role(kind, row["role"]) in kind.manuscript_roles()


# ---------------------------------------------------------------- TODO markers


def strip_markers(node: Any) -> Any:
    """A copy of a document with every [[...]] marker removed from its text."""
    if isinstance(node, list):
        return [strip_markers(n) for n in node]
    if not isinstance(node, dict):
        return node
    out = {k: v for k, v in node.items() if k != "content"}
    if node.get("type") == "text":
        text = TODO.sub("", node.get("text", ""))
        text = re.sub(r"[ \t]{2,}", " ", text)
        out["text"] = text
        return out
    if "content" in node:
        kids = [strip_markers(c) for c in node["content"]]
        out["content"] = [k for k in kids if not (k.get("type") == "text" and not k.get("text"))]
    return out


def todos(conn: sqlite3.Connection, folder_id: int) -> dict:
    """Every [[...]] marker in a folder (any depth), with chapter and scene."""
    top = folder_row(conn, folder_id)
    kind = require_kind(top["kind"])
    _tool(kind, "todo_markers")
    base = len(folder_path(conn, top["parent_id"]))
    items = []
    for what, _, row in walk(conn, folder_id):
        if what != "doc":
            continue
        for n, m in enumerate(TODO.finditer(row["plain_text"] or "")):
            items.append({
                "document_id": row["id"],
                "title": row["title"],
                "role": doc_role(kind, row["role"]),
                "path": [p["name"] for p in folder_path(conn, row["folder_id"])][base:],
                "text": m.group(1).strip(),
                "index": n,
            })
    return {"folder": {"id": top["id"], "name": top["name"]}, "todos": items}


# ---------------------------------------------------------------- compile


def _manuscript(conn: sqlite3.Connection, folder_id: int) -> tuple[Kind, sqlite3.Row, list[Any], int, int]:
    top = folder_row(conn, folder_id)
    kind = require_kind(top["kind"])
    _tool(kind, "compile")
    items: list[Any] = []
    words = 0
    markers = 0
    pending_first = True
    for what, depth, row in walk(conn, folder_id):
        if what == "folder":
            items.append(Section(row["name"], min(6, depth + 2)))
            pending_first = True
            continue
        if not in_manuscript(kind, row):
            continue  # misc notes are never compiled
        try:
            doc = json.loads(row["content_json"])
        except ValueError:
            doc = content.empty_doc()
        markers += len(TODO.findall(row["plain_text"] or ""))
        doc = strip_markers(doc)
        words += content.word_count(content.plain_text(doc))
        items.append(Part(title="", doc=doc, kind=kind, title_level=0, first=pending_first))
        pending_first = False
    return kind, top, items, words, markers


def check(conn: sqlite3.Connection, folder_id: int) -> dict:
    """What compiling would include, and any TODO markers left (a warning only)."""
    _, top, items, words, markers = _manuscript(conn, folder_id)
    return {
        "folder": {"id": top["id"], "name": top["name"]},
        "scenes": sum(1 for i in items if isinstance(i, Part)),
        "words": words,
        "todos": markers,
    }


def about(words: int) -> str:
    """Manuscript word counts are rounded: 'about 81,200 words'."""
    if words < 100:
        return f"{words} words"
    return f"about {int(round(words, -2)):,} words"


FORMATS = {
    "md": ("text/markdown; charset=utf-8", "md"),
    "html": ("text/html; charset=utf-8", "html"),
    "docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
}


def compile_folder(
    conn: sqlite3.Connection, folder_id: int, fmt: str, title_page: bool = True, author: str = ""
) -> tuple[bytes, str, str]:
    if fmt not in FORMATS:
        raise Invalid("format must be md, html or docx")
    author = " ".join((author or "").split())[:120]
    kind, top, items, words, _ = _manuscript(conn, folder_id)
    media, ext = FORMATS[fmt]
    filename = f"{safe_filename(top['name'])} (manuscript).{ext}"
    if fmt == "docx":
        return ManuscriptDocx(top["name"], items, words, title_page, author).render(), media, filename
    exp = Export(title=top["name"], kind=kind, items=items, scene_break=SCENE_BREAK)
    if title_page:
        exp.front = [line for line in (f"by {author}" if author else "", about(words)) if line]
    body = MarkdownRenderer(exp).render() if fmt == "md" else HtmlRenderer(exp).render()
    return body.encode("utf-8"), media, filename


class ManuscriptDocx:
    """Standard manuscript format: Times New Roman 12pt, double-spaced,
    1-inch margins, 0.5-inch first-line indents, each chapter on a new page
    with its heading a third of the way down, scene breaks marked '#', an
    optional title page with the word count, and a running header."""

    def __init__(self, title: str, items: list[Any], words: int, title_page: bool, author: str):
        self.title, self.items, self.words, self.title_page, self.author = title, items, words, title_page, author

    def render(self) -> bytes:
        from docx import Document
        from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn
        from docx.shared import Inches, Pt

        self.ALIGN, self.Inches, self.qn, self.OxmlElement = WD_ALIGN_PARAGRAPH, Inches, qn, OxmlElement
        doc = Document()
        self.doc = doc
        for style_name in ("Normal", "Heading 1", "Heading 2", "Heading 3"):
            st = doc.styles[style_name]
            st.font.name = "Times New Roman"
            st.font.size = Pt(12)
            st.font.bold = False
            st.font.italic = False
            if st.font.color is not None:
                st.font.color.rgb = None
            rpr = st.element.get_or_add_rPr()
            fonts = rpr.find(qn("w:rFonts"))
            if fonts is None:
                fonts = OxmlElement("w:rFonts")
                rpr.append(fonts)
            for attr in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
                fonts.set(qn(attr), "Times New Roman")
            pf = st.paragraph_format
            pf.line_spacing_rule = WD_LINE_SPACING.DOUBLE
            pf.space_before = Pt(0)
            pf.space_after = Pt(0)
        doc.styles["Normal"].paragraph_format.first_line_indent = Inches(0.5)
        for style_name in ("Heading 1", "Heading 2", "Heading 3"):
            doc.styles[style_name].paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
            doc.styles[style_name].paragraph_format.first_line_indent = Inches(0)
            doc.styles[style_name].paragraph_format.keep_with_next = True
        section = doc.sections[0]
        for side in ("left_margin", "right_margin", "top_margin", "bottom_margin"):
            setattr(section, side, Inches(1))
        doc.core_properties.title = self.title
        doc.core_properties.author = self.author
        doc.core_properties.comments = ""

        if self.title_page:
            top = doc.add_paragraph()
            top.paragraph_format.first_line_indent = Inches(0)
            top.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE
            top.paragraph_format.tab_stops.add_tab_stop(Inches(6.45), WD_TAB_ALIGNMENT.RIGHT)
            top.add_run(f"{self.author}\t{about(self.words)}")
            # Plain centred title (Word's Title style adds a rule and colour).
            t = doc.add_paragraph(self.title)
            t.alignment = WD_ALIGN_PARAGRAPH.CENTER
            t.paragraph_format.first_line_indent = Inches(0)
            t.paragraph_format.space_before = Inches(3)
            if self.author:
                by = doc.add_paragraph(f"by {self.author}")
                by.alignment = WD_ALIGN_PARAGRAPH.CENTER
                by.paragraph_format.first_line_indent = Inches(0)
            # The first heading starts the next page (page_break_before).
            # The running header starts after the title page.
            section.different_first_page_header_footer = True
        self._header(section)

        self.new_page = not self.title_page
        first_heading = True
        if not any(isinstance(i, Section) for i in self.items):
            # One chapter compiled on its own: its name is the chapter heading.
            self._heading(self.title, 1, first_heading)
            first_heading = False
        for item in self.items:
            if isinstance(item, Section):
                self._heading(item.title, max(1, item.level - 1), first_heading)
                first_heading = False
                continue
            if not item.first:
                self._scene_break()
            self._blocks(_children(item.doc))
        buf = io.BytesIO()
        doc.save(buf)
        return buf.getvalue()

    def _header(self, section) -> None:
        """'Surname / TITLE / page' at the top right of every page."""
        qn, OxmlElement = self.qn, self.OxmlElement
        p = section.header.paragraphs[0]
        p.alignment = self.ALIGN.RIGHT
        p.paragraph_format.first_line_indent = self.Inches(0)
        surname = self.author.split()[-1] if self.author else ""
        label = " / ".join(x for x in (surname, self.title.upper()) if x)
        p.add_run(f"{label} / ")
        run = p.add_run()
        for kind, text in (("begin", None), (None, "PAGE"), ("end", None)):
            if kind:
                el = OxmlElement("w:fldChar")
                el.set(qn("w:fldCharType"), kind)
            else:
                el = OxmlElement("w:instrText")
                el.set(qn("xml:space"), "preserve")
                el.text = text
            run._r.append(el)

    def _heading(self, text: str, level: int, first: bool) -> None:
        p = self.doc.add_heading(text, level=min(3, level))
        # Parts and chapters start on a new page, a third of the way down
        # (no break before the very first heading when there is no title page).
        p.paragraph_format.page_break_before = not (first and self.new_page)
        p.paragraph_format.space_before = self.Inches(2)
        p.paragraph_format.space_after = self.Inches(0.5)
        self.new_page = False

    def _scene_break(self) -> None:
        p = self.doc.add_paragraph(SCENE_BREAK)
        p.alignment = self.ALIGN.CENTER
        p.paragraph_format.first_line_indent = self.Inches(0)

    def _blocks(self, nodes: list[dict]) -> None:
        for n in nodes:
            t = n.get("type")
            if t in ("paragraph", "heading"):
                p = self.doc.add_paragraph()
                self._inline(p, _children(n))
            elif t == "blockquote":
                for c in _children(n):
                    p = self.doc.add_paragraph()
                    p.paragraph_format.left_indent = self.Inches(0.5)
                    self._inline(p, _children(c))
            elif t == "sectionBreak":
                self._scene_break()

    def _inline(self, p, nodes: list[dict]) -> None:
        for n in nodes:
            t = n.get("type")
            if t == "text":
                marks = {m.get("type") for m in _marks(n)}
                run = p.add_run(n.get("text", ""))
                run.italic = "italic" in marks or None
                run.bold = "bold" in marks or None
            elif t == "hardBreak":
                p.add_run().add_break()

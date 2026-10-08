"""Document content: validation against a kind, and plain-text extraction.

Content is stored as TipTap/ProseMirror JSON. For encrypted kinds the stored
value is an opaque envelope produced in the browser; the server only checks
its shape and never sees plain text.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from typing import Any

from .errors import Invalid
from .kinds import Kind

MAX_CONTENT_BYTES = 10 * 1024 * 1024
MAX_DEPTH = 64

ALWAYS_NODES = {"doc", "paragraph", "text"}

# Structural extensions -> the node and mark types they allow.
EXTENSION_TYPES: dict[str, dict[str, set[str]]] = {
    "heading": {"nodes": {"heading"}},
    "bold": {"marks": {"bold"}},
    "italic": {"marks": {"italic"}},
    "link": {"marks": {"link"}},
    "blockquote": {"nodes": {"blockquote"}},
    "footnote": {"nodes": {"footnote"}},
    "citation": {"marks": {"citation"}},
    "sectionBreak": {"nodes": {"sectionBreak"}},
    "hardBreak": {"nodes": {"hardBreak"}},
    "bulletList": {"nodes": {"bulletList", "listItem"}},
    "orderedList": {"nodes": {"orderedList", "listItem"}},
}

SAFE_LINK = re.compile(r"^(https?:|mailto:|#)", re.I)


def allowed_types(kind: Kind) -> tuple[set[str], set[str], set[int]]:
    nodes = set(ALWAYS_NODES)
    marks: set[str] = set()
    heading_levels: set[int] = set()
    for ext in kind.extensions:
        name, _, arg = ext.partition(":")
        spec = EXTENSION_TYPES.get(name)
        if spec:
            nodes |= spec.get("nodes", set())
            marks |= spec.get("marks", set())
        if name == "heading":
            heading_levels |= {int(x) for x in arg.split(",") if x.strip()} or {1, 2, 3}
    return nodes, marks, heading_levels


def empty_doc() -> dict:
    return {"type": "doc", "content": [{"type": "paragraph"}]}


def doc_from_text(text: str) -> dict:
    paragraphs = [p for p in re.split(r"\n\s*\n", text.strip()) if p.strip()] or [""]
    content = []
    for para in paragraphs:
        lines = para.split("\n")
        inline: list[dict] = []
        for i, line in enumerate(lines):
            if i:
                inline.append({"type": "hardBreak"})
            if line:
                inline.append({"type": "text", "text": line})
        node: dict[str, Any] = {"type": "paragraph"}
        if inline:
            node["content"] = inline
        content.append(node)
    return {"type": "doc", "content": content}


def parse_json(raw: str | dict) -> dict:
    if isinstance(raw, dict):
        return raw
    if len(raw.encode("utf-8")) > MAX_CONTENT_BYTES:
        raise Invalid("content is too large")
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        raise Invalid("content_json is not valid JSON") from None
    if not isinstance(value, dict):
        raise Invalid("content_json must be a JSON object")
    return value


def validate_doc(doc: dict, kind: Kind) -> dict:
    """Check that a document only uses node and mark types the kind allows."""
    nodes, marks, levels = allowed_types(kind)
    if doc.get("type") != "doc":
        raise Invalid("content must be a ProseMirror document")

    def walk(node: Any, depth: int) -> None:
        if depth > MAX_DEPTH:
            raise Invalid("content is nested too deeply")
        if not isinstance(node, dict):
            raise Invalid("content node must be an object")
        ntype = node.get("type")
        if ntype not in nodes:
            raise Invalid(f"node type {ntype!r} is not allowed in {kind.label}")
        if ntype == "text" and not isinstance(node.get("text"), str):
            raise Invalid("text node without text")
        if ntype == "heading":
            level = (node.get("attrs") or {}).get("level")
            if level not in levels:
                raise Invalid(f"heading level {level!r} is not allowed in {kind.label}")
        for mark in node.get("marks") or []:
            mtype = mark.get("type") if isinstance(mark, dict) else None
            if mtype not in marks:
                raise Invalid(f"mark {mtype!r} is not allowed in {kind.label}")
            if mtype == "link":
                href = str((mark.get("attrs") or {}).get("href") or "")
                if not SAFE_LINK.match(href):
                    raise Invalid("links must be http(s), mailto or #anchors")
        children = node.get("content")
        if children is not None:
            if not isinstance(children, list):
                raise Invalid("node content must be a list")
            for child in children:
                walk(child, depth + 1)

    walk(doc, 0)
    return doc


ENVELOPE_KEYS = {"v", "alg", "iv", "ct"}


def _b64(value: Any, what: str) -> bytes:
    if not isinstance(value, str):
        raise Invalid(f"encrypted envelope {what} must be base64")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise Invalid(f"encrypted envelope {what} must be base64") from None


def validate_envelope(raw: str | dict) -> str:
    """Accept only a well-formed AES-GCM envelope; return it re-serialised.

    Error messages never echo the submitted value.
    """
    value = parse_json(raw)
    if set(value.keys()) != ENVELOPE_KEYS:
        raise Invalid("encrypted kinds accept only an encrypted envelope")
    if value["v"] != 1 or value["alg"] != "AES-GCM":
        raise Invalid("unsupported envelope version")
    if len(_b64(value["iv"], "iv")) != 12:
        raise Invalid("envelope iv must be 12 bytes")
    if len(_b64(value["ct"], "ct")) < 16:
        raise Invalid("envelope ciphertext is too short")
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


BLOCK_TYPES = {"paragraph", "heading", "blockquote", "listItem", "bulletList", "orderedList"}


def plain_text(doc: dict) -> str:
    """Flatten a ProseMirror document to text for search and word counts."""
    out: list[str] = []

    def walk(node: dict) -> None:
        ntype = node.get("type")
        if ntype == "text":
            out.append(node.get("text", ""))
            return
        if ntype == "hardBreak":
            out.append("\n")
            return
        if ntype == "footnote":
            note = (node.get("attrs") or {}).get("text") or ""
            if note:
                out.append(f" ({note})")
            return
        if ntype == "sectionBreak":
            out.append("\n\n")
            return
        for child in node.get("content") or []:
            walk(child)
        if ntype in BLOCK_TYPES and ntype not in ("bulletList", "orderedList"):
            out.append("\n\n")

    walk(doc)
    text = "".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def word_count(text: str) -> int:
    return len(re.findall(r"\S+", text))

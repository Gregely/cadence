"""Produce envelopes exactly as the browser does (PBKDF2-SHA256 + AES-GCM)."""

import base64
import json
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

SALT = b"0123456789abcdef"
AAD = b"cadence:v1"


def derive(passphrase: str, salt: bytes = SALT, iterations: int = 1000) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(passphrase.encode())


def envelope(text: str, key: bytes | None = None) -> str:
    key = key or derive("correct horse")
    iv = os.urandom(12)
    payload = json.dumps({"doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}})
    ct = AESGCM(key).encrypt(iv, payload.encode(), AAD)
    return json.dumps({"v": 1, "alg": "AES-GCM", "iv": base64.b64encode(iv).decode(), "ct": base64.b64encode(ct).decode()})


def open_envelope(raw: str, key: bytes | None = None) -> dict:
    key = key or derive("correct horse")
    env = json.loads(raw)
    pt = AESGCM(key).decrypt(base64.b64decode(env["iv"]), base64.b64decode(env["ct"]), AAD)
    return json.loads(pt)

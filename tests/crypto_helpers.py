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
    key = key or vault_key()
    iv = os.urandom(12)
    payload = json.dumps({"doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}})
    ct = AESGCM(key).encrypt(iv, payload.encode(), AAD)
    return json.dumps({"v": 1, "alg": "AES-GCM", "iv": base64.b64encode(iv).decode(), "ct": base64.b64encode(ct).decode()})


def open_envelope(raw: str, key: bytes | None = None) -> dict:
    key = key or vault_key()
    env = json.loads(raw)
    pt = AESGCM(key).decrypt(base64.b64decode(env["iv"]), base64.b64decode(env["ct"]), AAD)
    return json.loads(pt)


def vault_payload(passphrase: str = "correct horse", iterations: int = 100_000) -> dict:
    key = derive(passphrase, SALT, iterations)
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, json.dumps({"check": "cadence"}).encode(), AAD)
    check = json.dumps({"v": 1, "alg": "AES-GCM", "iv": base64.b64encode(iv).decode(), "ct": base64.b64encode(ct).decode()})
    return {"kdf": "PBKDF2-SHA256", "iterations": iterations, "salt": base64.b64encode(SALT).decode(), "check_envelope": check}


# The default derive() uses 1000 iterations for speed; vault tests that need
# the real key use this.
_KEY_CACHE: dict = {}


def vault_key(passphrase: str = "correct horse", iterations: int = 100_000) -> bytes:
    k = (passphrase, iterations)
    if k not in _KEY_CACHE:
        _KEY_CACHE[k] = derive(passphrase, SALT, iterations)
    return _KEY_CACHE[k]

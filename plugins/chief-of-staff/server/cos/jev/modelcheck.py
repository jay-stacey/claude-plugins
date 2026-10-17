"""Checks for local Jev model files: allowlisted publisher, pinned commit, safe file
format, pinned SHA256 and an open license. Nothing here downloads or runs a model."""
import hashlib
import json
import re
from pathlib import Path

MANIFEST_PATH = Path(__file__).with_name("models.json")

# Publishers whose files may be downloaded. unsloth is added because Qwen publishes no
# GGUF for Qwen3.5-0.8B or Qwen3.5-2B; unsloth only converts the official Qwen weights,
# and the SHA256 pin means a later change to its repo cannot reach a user.
ALLOWED_PUBLISHERS = ("Qwen", "google", "microsoft", "ibm-granite", "HuggingFaceTB", "BAAI", "unsloth")
ALLOWED_LICENSES = ("Apache-2.0", "MIT")
ALLOWED_SUFFIXES = (".gguf", ".safetensors")
REQUIRED = ("id", "publisher", "repo", "commit", "file", "sha256", "license", "sizeBytes", "params")

_HEX40 = re.compile(r"^[0-9a-f]{40}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_SAFE_PART = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def load_manifest(path=MANIFEST_PATH) -> list:
    return json.loads(Path(path).read_text(encoding="utf-8")).get("models", [])


MANIFEST = load_manifest()


def find(model_id: str):
    return next((e for e in MANIFEST if e.get("id") == model_id), None)


def check_entry(entry: dict) -> list:
    """Problems with one manifest entry, as plain sentences. Empty means it passes."""
    if not isinstance(entry, dict):
        return ["entry is not an object"]
    problems = [f"missing {k}" for k in REQUIRED if entry.get(k) in (None, "")]
    if "trust_remote_code" in json.dumps(entry).lower().replace("-", "_"):
        problems.append("trust_remote_code is refused")
    publisher = str(entry.get("publisher") or "")
    repo = str(entry.get("repo") or "")
    if publisher and publisher not in ALLOWED_PUBLISHERS:
        problems.append(f"publisher {publisher} is not on the allowlist")
    parts = repo.split("/")
    if repo and (len(parts) != 2 or not all(_SAFE_PART.match(p) for p in parts)):
        problems.append("repo must be owner/name")
    elif repo and parts[0] != publisher:
        problems.append("repo owner does not match the publisher")
    if entry.get("license") and entry["license"] not in ALLOWED_LICENSES:
        problems.append(f"license {entry['license']} is not Apache-2.0 or MIT")
    file = str(entry.get("file") or "")
    if file:
        if not file.lower().endswith(ALLOWED_SUFFIXES):
            problems.append("file must be .gguf or .safetensors")
        if not all(_SAFE_PART.match(p) for p in file.split("/")):
            problems.append("file name is not safe")
    if entry.get("commit") and not _HEX40.match(str(entry["commit"])):
        problems.append("commit must be a 40-character hex hash, not a branch")
    if entry.get("sha256") and not _HEX64.match(str(entry["sha256"])):
        problems.append("sha256 must be 64 lowercase hex characters")
    size = entry.get("sizeBytes")
    if size not in (None, "") and (isinstance(size, bool) or not isinstance(size, int) or size <= 0):
        problems.append("sizeBytes must be a positive whole number")
    return problems


def download_url(entry: dict) -> str:
    return f"https://huggingface.co/{entry['repo']}/resolve/{entry['commit']}/{entry['file']}"


def sha256_file(path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def verify_file(path, entry: dict) -> None:
    """Raises ValueError when the file's size or SHA256 is not the pinned value."""
    p = Path(path)
    if not p.is_file():
        raise ValueError(f"{p.name} is missing")
    size = p.stat().st_size
    if entry.get("sizeBytes") and size != entry["sizeBytes"]:
        raise ValueError(f"{p.name} is {size} bytes, expected {entry['sizeBytes']}")
    digest = sha256_file(p)
    if digest != str(entry.get("sha256", "")).lower():
        raise ValueError(f"{p.name} SHA256 does not match the pinned value")

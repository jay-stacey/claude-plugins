"""API key references for Jev. A key is never stored in a plain setting: a setting
holds a reference ("env:NAME" or "wincred:target") and this module reads the key
when it is needed. Windows Credential Manager is reached through ctypes (advapi32).
Never log or print a value this module returns."""
import os
import re
import sys

ENV_PREFIX = "env:"
WINCRED_PREFIX = "wincred:"

CRED_TYPE_GENERIC = 1
CRED_PERSIST_LOCAL_MACHINE = 2
ERROR_NOT_FOUND = 1168
MAX_BLOB = 5 * 512  # CRED_MAX_CREDENTIAL_BLOB_SIZE

_KEY_PREFIXES = ("sk-", "sk-ant-", "gsk_")
_LONG_TOKEN = re.compile(r"^[A-Za-z0-9+/=_\-.]{32,}$")


def looks_like_key(text) -> bool:
    """True when text looks like a raw API key, not a reference."""
    if not isinstance(text, str):
        return False
    t = text.strip()
    if not t or " " in t:
        return False
    if t.startswith((ENV_PREFIX, WINCRED_PREFIX)):
        return False
    if t.startswith(_KEY_PREFIXES) and len(t) >= 12:
        return True
    return bool(_LONG_TOKEN.match(t))


def resolve(ref, raw=None):
    """The key for a reference. raw wins when non-empty. None when nothing is set
    or the referenced key is missing. Raises ValueError for an unknown reference."""
    if raw and str(raw).strip():
        return str(raw).strip()
    if not ref:
        return None
    ref = str(ref).strip()
    if ref.startswith(ENV_PREFIX):
        name = ref[len(ENV_PREFIX):]
        if not name:
            raise ValueError("not a key reference")
        return os.environ.get(name) or None
    if ref.startswith(WINCRED_PREFIX):
        target = ref[len(WINCRED_PREFIX):]
        if not target:
            raise ValueError("not a key reference")
        return read_wincred(target)
    raise ValueError("not a key reference")


# --- Windows Credential Manager -------------------------------------------------

def _api():
    if sys.platform != "win32":
        raise ValueError("Windows Credential Manager is only on Windows")
    import ctypes
    from ctypes import wintypes

    class FILETIME(ctypes.Structure):
        _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]

    class CREDENTIALW(ctypes.Structure):
        _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
                    ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
                    ("LastWritten", FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                    ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
                    ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
                    ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR)]

    adv = ctypes.WinDLL("advapi32", use_last_error=True)
    pcred = ctypes.POINTER(CREDENTIALW)
    adv.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(pcred)]
    adv.CredReadW.restype = wintypes.BOOL
    adv.CredWriteW.argtypes = [pcred, wintypes.DWORD]
    adv.CredWriteW.restype = wintypes.BOOL
    adv.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
    adv.CredDeleteW.restype = wintypes.BOOL
    adv.CredFree.argtypes = [ctypes.c_void_p]
    adv.CredFree.restype = None
    return ctypes, adv, CREDENTIALW, pcred


def read_wincred(target: str):
    """The secret of a generic credential, or None when it does not exist."""
    ctypes, adv, _, pcred = _api()
    out = pcred()
    if not adv.CredReadW(target, CRED_TYPE_GENERIC, 0, ctypes.byref(out)):
        err = ctypes.get_last_error()
        if err == ERROR_NOT_FOUND:
            return None
        raise OSError(err, "CredReadW failed")
    try:
        cred = out.contents
        blob = ctypes.string_at(cred.CredentialBlob, cred.CredentialBlobSize)
    finally:
        adv.CredFree(out)
    if not blob:
        return None
    # Credentials written by this module (and cmdkey) are UTF-16LE; fall back to UTF-8.
    try:
        text = blob.decode("utf-16-le") if len(blob) % 2 == 0 else blob.decode("utf-8")
    except UnicodeDecodeError:
        text = blob.decode("utf-8", errors="replace")
    return text.rstrip("\x00") or None


def store_wincred(target: str, secret: str) -> None:
    """Write a generic credential for this user on this machine."""
    if not target or not secret:
        raise ValueError("target and secret are required")
    ctypes, adv, CREDENTIALW, _ = _api()
    data = secret.encode("utf-16-le")
    if len(data) > MAX_BLOB:
        raise ValueError("secret is too long")
    buf = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    cred = CREDENTIALW()
    cred.Type = CRED_TYPE_GENERIC
    cred.TargetName = target
    cred.CredentialBlobSize = len(data)
    cred.CredentialBlob = ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte))
    cred.Persist = CRED_PERSIST_LOCAL_MACHINE
    cred.UserName = "chief-of-staff"
    if not adv.CredWriteW(ctypes.byref(cred), 0):
        raise OSError(ctypes.get_last_error(), "CredWriteW failed")


def delete_wincred(target: str) -> bool:
    """Remove a generic credential. False when it did not exist."""
    ctypes, adv, _, _ = _api()
    if adv.CredDeleteW(target, CRED_TYPE_GENERIC, 0):
        return True
    err = ctypes.get_last_error()
    if err == ERROR_NOT_FOUND:
        return False
    raise OSError(err, "CredDeleteW failed")

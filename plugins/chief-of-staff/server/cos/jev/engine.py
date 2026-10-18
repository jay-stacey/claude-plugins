"""Jev: rules at once, then an optional model refine inside a short time cap.

Any provider error or a slow answer falls back to the rules answer, so Jev
never blocks a prompt for longer than jevTimeoutMs. Jay's own overrides in
the text always win over the model.
"""
import logging
import threading
import time
from dataclasses import replace
from pathlib import Path

from . import rules
from .decision import Decision, Request, parse
from .log import DecisionLog
from .settings import effective

log = logging.getLogger("cos.jev")
WARN_EVERY_S = 60


def default_provider_factory(cfg: dict, key):
    """Builds the provider from the merged settings. None means rules only."""
    try:
        from .keys import resolve
        from .providers import make_provider
    except ImportError:
        return None
    # A raw key from the mod is the hosted key; a local runtime never gets it.
    raw = key if cfg.get("provider") == "hosted" else None
    try:
        secret = resolve(cfg.get("keyRef") or None, raw)
    except ValueError:
        secret = raw or None
    if cfg.get("provider") == "hosted" and not secret:
        return None                      # a hosted model needs a key; rules until one is set
    return make_provider({k: cfg.get(k) for k in ("provider", "adapter", "model", "endpoint")}, secret)


class Jev:
    def __init__(self, settings: dict, home: Path, key=None, provider_factory=None, clock=time.perf_counter):
        self.home = Path(home)
        self.clock = clock
        self.factory = provider_factory or default_provider_factory
        self.log = DecisionLog(self.home / "jev-log.jsonl")
        self.lock = threading.Lock()
        self.fallbacks = 0
        self.last_warn = 0.0
        self.provider = None
        self.cfg = effective({}, self.home)
        self._signature = None
        self.update(settings, key)

    # ------------------------------------------------------------ setup --
    def update(self, settings: dict, key=None):
        """Builds the provider again when the settings or the key changed."""
        cfg = effective(settings or {}, self.home)
        signature = (tuple(sorted(cfg.items())), key)
        with self.lock:
            if signature == self._signature:
                return
        provider = None
        if cfg["provider"] in ("local", "hosted"):
            try:
                provider = self.factory(cfg, key)
            except Exception as err:
                self.warn(f"provider not built ({type(err).__name__})")
        with self.lock:
            self.cfg, self.provider, self._signature = cfg, provider, signature

    def provider_name(self) -> str:
        """"rules" when no model provider is in use, else "local" or "hosted"."""
        with self.lock:
            return getattr(self.provider, "name", None) or "rules" if self.provider is not None else "rules"

    def health(self) -> dict:
        with self.lock:
            return {"provider": self.cfg["provider"], "model": self.cfg["model"] or None,
                    "active": getattr(self.provider, "name", None) if self.provider is not None else "rules",
                    "fallbacks": self.fallbacks}

    def warn(self, reason: str):
        """One log line a minute at most, and never the request text."""
        now = time.monotonic()
        if now - self.last_warn >= WARN_EVERY_S:
            self.last_warn = now
            log.warning("Jev used its rules: %s", reason)

    # --------------------------------------------------------- deciding --
    def quick(self, request: Request) -> Decision:
        start = self.clock()
        d = rules.quick(request)
        d.ms = (self.clock() - start) * 1000
        return d

    def advise(self, request: Request, quick: Decision) -> Decision:
        """The model's answer within jevTimeoutMs, or `quick` on any error or timeout."""
        user = rules.overrides(request.text) if quick.override else {}
        if "model" in user and "route" in user:
            return quick
        with self.lock:
            provider, timeout_s = self.provider, self.cfg["timeoutMs"] / 1000.0
        if provider is None:
            return quick
        start = self.clock()
        box = {}

        def run():
            try:
                box["raw"] = provider.decide(request, timeout_s)
            except Exception as err:          # the provider's own failure, whatever it is
                box["err"] = err

        worker = threading.Thread(target=run, name="cos-jev-call", daemon=True)
        worker.start()
        worker.join(timeout_s)
        ms = (self.clock() - start) * 1000
        if worker.is_alive():
            return self.fallback(quick, "timeout")
        if "err" in box:
            return self.fallback(quick, type(box["err"]).__name__)
        try:
            d = parse(box.get("raw"), quick.filler, getattr(provider, "name", "local"), ms)
        except ValueError:
            return self.fallback(quick, "bad answer")
        if "model" in user:
            d.model = quick.model
        if "route" in user:
            d.route, d.background = quick.route, quick.background
        if user:
            d.override = True
        return d

    def fallback(self, quick: Decision, reason: str) -> Decision:
        with self.lock:
            self.fallbacks += 1
        self.warn(reason)
        return replace(quick)

    # ---------------------------------------------------------- logging --
    def record(self, msg_id, request: Request, decision: Decision, quick: Decision | None = None) -> bool:
        return self.log.record(msg_id, request.text, request.source, (quick or decision).public(), decision.public())

    def outcome(self, msg_id, route, model) -> bool:
        return self.log.outcome(msg_id, route, model)

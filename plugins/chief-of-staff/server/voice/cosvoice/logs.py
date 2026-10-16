"""Logging to HOME\\logs\\voice.log (rotate at 5 MB, keep 2)."""

from __future__ import annotations

import logging
import logging.handlers
import sys

from . import config

LOG = logging.getLogger("cosvoice")


def setup(to_stderr: bool = False, level: int = logging.INFO) -> logging.Logger:
    LOG.setLevel(level)
    LOG.propagate = False
    for h in list(LOG.handlers):
        LOG.removeHandler(h)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(threadName)s %(message)s")
    try:
        d = config.logs_dir()
        d.mkdir(parents=True, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(
            d / "voice.log", maxBytes=5 * 1024 * 1024, backupCount=2, encoding="utf-8", delay=True)
        fh.setFormatter(fmt)
        LOG.addHandler(fh)
    except OSError:
        to_stderr = True
    if to_stderr:
        sh = logging.StreamHandler(sys.stderr)
        sh.setFormatter(fmt)
        LOG.addHandler(sh)
    return LOG

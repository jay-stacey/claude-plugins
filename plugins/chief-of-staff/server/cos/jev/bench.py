"""The live test for a Jev model provider: warm up, then time real-shape decisions.
Standard library only. The session titles below are made up."""
import math
import time

from .decision import Request, parse

_SESSIONS = [
    {"title": "Fix the invoice export rounding", "repo": "billing-api", "state": "working", "model": "sonnet"},
    {"title": "Draft the release notes for 4.2", "repo": "docs-site", "state": "waiting", "model": "haiku"},
    {"title": "Plan the search index rebuild", "repo": "search-service", "state": "idle", "model": "opus"},
    {"title": "Review the login page pull request", "repo": "web-app", "state": "waiting", "model": "sonnet"},
]

SAMPLES = [
    Request("what needs me right now", "voice", _SESSIONS),
    Request("archive the release notes session", "voice", _SESSIONS),
    Request("tell the invoice session to run the tests again", "typed", _SESSIONS, "billing-api"),
    Request("fix the flaky checkout test in the web app", "voice", _SESSIONS, "web-app"),
    Request("design a caching layer for the search service", "typed", _SESSIONS, "search-service"),
    Request("how is the login review going", "voice", _SESSIONS),
    Request("write a short summary of yesterday's commits", "typed", _SESSIONS, "docs-site"),
    Request("debug why the nightly import job runs out of memory", "voice", _SESSIONS, "billing-api"),
    Request("which sessions are waiting on me", "voice", _SESSIONS),
    Request("research how other tools rank search results and write it up", "typed", _SESSIONS, "search-service"),
]


def percentile(values, pct):
    """Nearest-rank percentile, or None for no values."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(pct / 100 * len(ordered)))
    return ordered[rank - 1]


def run(provider, samples, warmups=1, timeout_s=5.0, clock=time.perf_counter):
    """{"p50": ms, "p95": ms, "valid": n, "total": n}. A failed call counts as invalid and
    its time still counts. Never raises for a provider error."""
    samples = list(samples or [])
    for i in range(warmups if samples else 0):
        try:
            provider.decide(samples[i % len(samples)], timeout_s)
        except Exception:
            pass
    times, valid = [], 0
    for request in samples:
        start = clock()
        try:
            raw = provider.decide(request, timeout_s)
        except Exception:
            raw = None
        times.append((clock() - start) * 1000)
        if raw is not None:
            try:
                parse(raw)
                valid += 1
            except ValueError:
                pass
    p50, p95 = percentile(times, 50), percentile(times, 95)
    return {"p50": None if p50 is None else round(p50), "p95": None if p95 is None else round(p95),
            "valid": valid, "total": len(samples)}

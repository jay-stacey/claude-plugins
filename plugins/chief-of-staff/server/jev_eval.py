"""Run Jev's 50-request labeled set and report agreement, speed and failures.

    python jev_eval.py [--provider rules|config] [--set path] [--verbose]

rules runs cos.jev.rules.quick. config runs the provider in the current settings
(userConfig over HOME/jev.json); a hosted provider sends the set's made-up text to
that service. Exit code 1 when agreement is below the targets in issue 33.
Never prints a key or a request body."""
import argparse
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from cos.jev.decision import MODELS, ROUTES, Request, parse  # noqa: E402

DEFAULT_SET = HERE / "tests" / "fixtures" / "jev-eval.json"
FIELDS = ("route", "model", "background")
TARGETS = {"route": 0.85, "background": 0.85, "model": 0.75}


def load_set(path=DEFAULT_SET) -> list:
    items = json.loads(Path(path).read_text(encoding="utf-8"))
    for i, item in enumerate(items):
        want = item.get("want") or {}
        if not isinstance(item.get("text"), str) or not item["text"].strip():
            raise ValueError(f"item {i}: no text")
        if want.get("route") not in ROUTES or want.get("model") not in MODELS or not isinstance(want.get("background"), bool):
            raise ValueError(f"item {i}: bad labels")
    return items


def request_of(item) -> Request:
    return Request(text=item["text"], source="typed", sessions=item.get("sessions") or [], repo=item.get("repo"))


def percentile(values, p):
    if not values:
        return 0.0
    v = sorted(values)
    k = max(0, min(len(v) - 1, int(round(p / 100 * (len(v) - 1)))))
    return v[k]


def run(decide, items, clock=time.perf_counter) -> dict:
    """decide(request) -> Decision. A raised error counts as a failure and a miss on every field."""
    hits = {f: 0 for f in FIELDS}
    times, failures, misses = [], [], []
    for i, item in enumerate(items):
        start = clock()
        try:
            got = decide(request_of(item))
        except Exception as err:  # noqa: BLE001 - any provider error is one failure
            times.append((clock() - start) * 1000)
            failures.append({"index": i, "text": item["text"][:80], "error": str(err)[:120]})
            continue
        times.append((clock() - start) * 1000)
        wrong = {}
        for f in FIELDS:
            value = getattr(got, f)
            if value == item["want"][f]:
                hits[f] += 1
            else:
                wrong[f] = {"want": item["want"][f], "got": value}
        if wrong:
            misses.append({"index": i, "text": item["text"][:80], "wrong": wrong})
    total = len(items)
    agreement = {f: (hits[f] / total if total else 0.0) for f in FIELDS}
    return {"total": total, "agreement": agreement, "p50": percentile(times, 50), "p95": percentile(times, 95),
            "failures": failures, "misses": misses,
            "passed": all(agreement[f] >= TARGETS[f] for f in FIELDS)}


def rules_decider():
    from cos.jev import rules
    return rules.quick


def config_decider():
    from cos import config, paths
    from cos.jev import keys, providers, settings
    cfg = settings.effective(config.load(), paths.home())
    key = keys.resolve(cfg.get("keyRef"), os.environ.get("JEV_API_KEY"))
    provider = providers.make_provider(cfg, key)
    if provider is None:
        print("The configured provider is rules; running rules.")
        return rules_decider(), "rules"
    timeout_s = cfg.get("timeoutMs", 800) / 1000

    def decide(request):
        start = time.perf_counter()
        raw = provider.decide(request, timeout_s)
        return parse(raw, source=provider.name, ms=(time.perf_counter() - start) * 1000)
    return decide, f"{provider.name} ({cfg.get('adapter')}, {cfg.get('model')})"


def report(result, label) -> str:
    lines = [f"Jev eval: {label}, {result['total']} requests"]
    for f in FIELDS:
        a = result["agreement"][f]
        mark = "ok" if a >= TARGETS[f] else "BELOW TARGET"
        lines.append(f"  {f:<10} {a * 100:5.1f}%  (target {TARGETS[f] * 100:.0f}%)  {mark}")
    lines.append(f"  speed      p50 {result['p50']:.2f} ms, p95 {result['p95']:.2f} ms")
    lines.append(f"  failures   {len(result['failures'])}")
    for fail in result["failures"][:10]:
        lines.append(f"    #{fail['index']}: {fail['error']}")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Run Jev's labeled eval set.")
    ap.add_argument("--provider", choices=("rules", "config"), default="rules")
    ap.add_argument("--set", default=str(DEFAULT_SET), help="path to the labeled set (JSON)")
    ap.add_argument("--verbose", action="store_true", help="list every miss")
    args = ap.parse_args(argv)
    items = load_set(args.set)
    if args.provider == "rules":
        decide, label = rules_decider(), "rules"
    else:
        try:
            decide, label = config_decider()
        except ValueError as err:
            print(f"Cannot use the configured provider: {err}")
            return 2
    result = run(decide, items)
    print(report(result, label))
    if args.verbose:
        for miss in result["misses"]:
            print(f"  miss #{miss['index']}: {miss['text']} -> {json.dumps(miss['wrong'])}")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())

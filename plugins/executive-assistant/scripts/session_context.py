#!/usr/bin/env python3
"""SessionStart hook: start a new Claude session with a short day-plan anchor.

Opt-in. It prints at most three short lines (Now task, next meeting, focus
timer and parked count) as SessionStart additionalContext. It is silent when
the switch is off, the notes folder is missing, or anything at all goes wrong:
a SessionStart hook must never break or slow a session.

Stdlib only. Run: python session_context.py [--vault DIR] [--enabled true] [--now ISO]
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from plugin_config import option  # noqa: E402

MAX_CHARS = 400
MEETING_MINUTES_LIMIT = 90
INSTRUCTION = "Mention this only if the user asks what to do next or seems to be switching tasks."
TRUE_WORDS = ("true", "1", "yes")


def real_value(value):
    """An arg counts only if it is non-empty and not an unreplaced ${...} placeholder."""
    if value is None:
        return None
    value = str(value).strip()
    if not value or value.startswith("${"):
        return None
    return value


def is_on(value):
    return str(value).strip().lower() in TRUE_WORDS


def clean(text, limit):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(text) > limit:
        text = text[: limit - 3].rstrip() + "..."
    return text


def read_json(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def parse_time(text):
    try:
        return dt.datetime.fromisoformat(str(text))
    except (TypeError, ValueError):
        return None


def plural(n, word):
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def task_parts(vault):
    """Return (now_line, parked_count). Either may be empty."""
    import tasks

    store = tasks.Store(vault)
    now_line, parked = "", 0
    for task in store.all():
        f = task["fields"]
        if f.get("list") == "now" and not now_line:
            title = clean(f.get("title"), 50)
            step = clean(f.get("next_step"), 70)
            label = "Next step"
            if not step:
                step, label = clean(f.get("first_step"), 70), "First step"
            if title:
                now_line = f'Now task is "{title}" ({f.get("id")}).'
                if step:
                    now_line += f" {label}: {step}"
        if f.get("parked_at") and f.get("list") not in ("done", "dropped"):
            parked += 1
    return now_line, parked


def meeting_line(vault, now):
    today = now.strftime("%Y-%m-%d")
    brief = read_json(Path(vault) / ".assistant" / "brief" / f"{today}.json")
    if not brief:
        return ""
    best = None
    for day in (brief.get("calendar") or {}).get("days") or []:
        if not isinstance(day, dict) or day.get("date") != today:
            continue
        for ev in day.get("events") or []:
            if not isinstance(ev, dict) or ev.get("kind") != "meet":
                continue
            start = parse_time(f"{today}T{ev.get('start')}")
            if start and start > now and (best is None or start < best[0]):
                best = (start, ev)
    if not best:
        return ""
    start, ev = best
    minutes = -(-int((start - now).total_seconds()) // 60)
    when = f"in {plural(minutes, 'minute')}" if minutes < MEETING_MINUTES_LIMIT else ""
    at = start.strftime("%H:%M")
    title = clean(ev.get("title"), 50) or "a meeting"
    return f"Next meeting: {title} at {at}" + (f", {when}." if when else ".")


def focus_text(vault, now):
    focus = read_json(Path(vault) / ".assistant" / "focus.json")
    if not focus:
        return ""
    ends = parse_time(focus.get("ends_at"))
    if ends and ends > now:
        return f"Focus timer running until {ends.strftime('%H:%M')}."
    return ""


def build(vault, now):
    lines = []
    parked = 0
    try:
        now_line, parked = task_parts(vault)
        if now_line:
            lines.append(now_line)
    except Exception:
        pass
    try:
        line = meeting_line(vault, now)
        if line:
            lines.append(line)
    except Exception:
        pass
    third = []
    try:
        text = focus_text(vault, now)
        if text:
            third.append(text)
    except Exception:
        pass
    if parked:
        third.append(f"{plural(parked, 'task')} parked.")
    if third:
        lines.append(" ".join(third))
    if not lines:
        return ""
    lines[0] = "Day plan (executive-assistant): " + lines[0]
    text = "\n".join(lines + [INSTRUCTION])
    return text if len(text) < MAX_CHARS else ""


def run(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault")
    parser.add_argument("--enabled")
    parser.add_argument("--now")
    args, _ = parser.parse_known_args(argv)

    enabled = real_value(args.enabled)
    if enabled is None:
        enabled = option("session_context", "")
    if not is_on(enabled):
        return
    vault = real_value(args.vault) or (option("notes_vault_path") or "").strip()
    if not vault or not Path(vault).expanduser().is_dir():
        return
    vault = str(Path(vault).expanduser())
    now = parse_time(args.now) if args.now else dt.datetime.now().replace(microsecond=0)
    if now is None:
        return
    text = build(vault, now)
    if text:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                                 "additionalContext": text}}))


def main(argv=None):
    try:
        run(sys.argv[1:] if argv is None else argv)
    except BaseException:  # never break a session
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

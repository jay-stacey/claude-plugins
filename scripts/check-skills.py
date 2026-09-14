#!/usr/bin/env python3
"""Structural checks the manifest validator does not cover.

Catches the failure modes that silently drop components:
  - a plugin on disk that is not registered in marketplace.json (invisible
    to anyone installing from this marketplace), or registered with no
    matching directory
  - skills nested too deep (skills/<group>/<name>/SKILL.md never loads)
  - SKILL.md `name` not matching its directory
  - missing description
  - SKILL.md over the 500-line guidance
  - agent/command references to skills or agents that do not exist
"""
import glob
import json
import os
import re
import sys

errors: list[str] = []
warnings: list[str] = []


def frontmatter(path: str) -> str | None:
    text = open(path, encoding="utf-8").read()
    if not text.startswith("---"):
        errors.append(f"{path}: frontmatter must start on line 1")
        return None
    parts = text.split("---", 2)
    return parts[1] if len(parts) > 2 else None


def field(fm: str, key: str) -> str | None:
    m = re.search(rf"^{key}:\s*(.+?)\s*$", fm, re.M)
    return m.group(1) if m else None


MARKETPLACE = ".claude-plugin/marketplace.json"
if os.path.exists(MARKETPLACE):
    catalog = json.load(open(MARKETPLACE, encoding="utf-8"))
    entries = catalog.get("plugins", [])
    registered = {p["name"] for p in entries}
    on_disk = {os.path.basename(os.path.normpath(d)) for d in glob.glob("plugins/*/")}

    for name in sorted(on_disk - registered):
        errors.append(
            f"plugins/{name}/ exists but is not registered in {MARKETPLACE} "
            "- it will not be installable"
        )
    for name in sorted(registered - on_disk):
        errors.append(f"{MARKETPLACE} registers '{name}' but plugins/{name}/ does not exist")

    root = catalog.get("metadata", {}).get("pluginRoot")
    for entry in entries:
        src = entry.get("source", "")
        if root == "./plugins" and isinstance(src, str) and src.startswith("./plugins/"):
            warnings.append(
                f"{MARKETPLACE}: '{entry['name']}' source '{src}' repeats pluginRoot; "
                f"use './{entry['name']}'"
            )
        ver = entry.get("version")
        manifest = f"plugins/{entry['name']}/.claude-plugin/plugin.json"
        if ver and os.path.exists(manifest):
            pv = json.load(open(manifest, encoding="utf-8")).get("version")
            if pv and pv != ver:
                errors.append(
                    f"version mismatch for '{entry['name']}': marketplace.json says {ver}, "
                    f"plugin.json says {pv}"
                )
else:
    errors.append(f"{MARKETPLACE} not found - this is not a valid marketplace root")


for plugin in sorted(glob.glob("plugins/*/")):
    name = os.path.basename(os.path.normpath(plugin))

    for deep in glob.glob(f"{plugin}skills/*/*/SKILL.md"):
        errors.append(f"{deep}: nested too deep - will not be discovered")

    skills: set[str] = set()
    skill_agent_refs: list[tuple[str, str | None]] = []
    for f in sorted(glob.glob(f"{plugin}skills/*/SKILL.md")):
        d = os.path.basename(os.path.dirname(f))
        skills.add(d)
        fm = frontmatter(f)
        if fm is None:
            continue
        if (n := field(fm, "name")) != d:
            errors.append(f"{f}: name '{n}' does not match directory '{d}'")
        if not field(fm, "description"):
            errors.append(f"{f}: missing description")
        n_lines = sum(1 for _ in open(f, encoding="utf-8"))
        if n_lines > 500:
            warnings.append(f"{f}: {n_lines} lines (>500; move detail to references/)")
        if field(fm, "agent") and "context: fork" not in fm:
            errors.append(f"{f}: 'agent:' requires 'context: fork' to take effect")
        skill_agent_refs.append((f, field(fm, "agent")))

    agents: set[str] = set()
    for f in sorted(glob.glob(f"{plugin}agents/*.md")):
        fm = frontmatter(f)
        if fm is None:
            continue
        if a := field(fm, "name"):
            agents.add(a)
        if "context: fork" in fm:
            errors.append(f"{f}: 'context: fork' is a skill field, not an agent field")
        for s in re.findall(r"^\s+-\s+(\S+)\s*$", fm, re.M):
            if s not in skills:
                errors.append(f"{f}: references unknown skill '{s}'")

    for path, ref in skill_agent_refs:
        if ref and ref not in agents:
            errors.append(f"{path}: routes to unknown agent '{ref}'")

    for f in sorted(glob.glob(f"{plugin}commands/*.md")):
        fm = frontmatter(f)
        if fm is None:
            continue
        if (a := field(fm, "agent")) and a not in agents:
            errors.append(f"{f}: routes to unknown agent '{a}'")
        if (s := field(fm, "skills")) and s not in skills:
            errors.append(f"{f}: references unknown skill '{s}'")

    print(f"{name}: {len(skills)} skills, {len(agents)} agents")

for w in warnings:
    print(f"warning: {w}")
for e in errors:
    print(f"ERROR: {e}", file=sys.stderr)

if errors:
    sys.exit(1)
print("\nStructure OK.")

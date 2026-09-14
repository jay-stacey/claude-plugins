#!/usr/bin/env python3
"""Structural checks the manifest validator does not cover.

Catches the failure modes that silently drop components:
  - skills nested too deep (skills/<group>/<name>/SKILL.md never loads)
  - SKILL.md `name` not matching its directory
  - missing description
  - SKILL.md over the 500-line guidance
  - agent/command references to skills or agents that do not exist
"""
import glob
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


for plugin in sorted(glob.glob("plugins/*/")):
    name = os.path.basename(os.path.normpath(plugin))

    for deep in glob.glob(f"{plugin}skills/*/*/SKILL.md"):
        errors.append(f"{deep}: nested too deep - will not be discovered")

    skills: set[str] = set()
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

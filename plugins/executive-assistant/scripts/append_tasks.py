#!/usr/bin/env python3
"""
Append tasks to specific sections of Obsidian daily note
"""

import sys
import json
from pathlib import Path
from datetime import datetime

def append_to_section(file_path, section_name, tasks):
    """Append tasks to a specific markdown section"""

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    except FileNotFoundError:
        print(f"Error: File not found: {file_path}", file=sys.stderr)
        return False

    # Find section
    section_start = None
    section_end = None

    for i, line in enumerate(lines):
        if section_name in line and line.startswith('##'):
            section_start = i
        elif section_start is not None and line.startswith('##'):
            section_end = i
            break

    if section_start is None:
        print(f"Error: Section '{section_name}' not found", file=sys.stderr)
        return False

    if section_end is None:
        section_end = len(lines)

    # Insert tasks after section header
    insert_pos = section_start + 1

    # Skip blank lines after header
    while insert_pos < len(lines) and lines[insert_pos].strip() == '':
        insert_pos += 1

    # Format tasks as checkboxes
    task_lines = [f"- [ ] {task}\n" for task in tasks]

    # Insert tasks
    lines[insert_pos:insert_pos] = task_lines

    # Write back
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.writelines(lines)
    except Exception as e:
        print(f"Error writing file: {e}", file=sys.stderr)
        return False

    return True

def main():
    """Main entry point"""

    try:
        # Read JSON from stdin
        data = json.load(sys.stdin)

        file_path = data['file_path']
        section = data['section']
        tasks = data['tasks']

        if not isinstance(tasks, list):
            print("Error: 'tasks' must be a list", file=sys.stderr)
            sys.exit(1)

        success = append_to_section(file_path, section, tasks)

        if success:
            print(f"✅ Added {len(tasks)} task(s) to '{section}' section")
        else:
            sys.exit(1)

    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyError as e:
        print(f"Error: Missing required key: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()

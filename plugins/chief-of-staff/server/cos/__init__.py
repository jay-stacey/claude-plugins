"""Chief of Staff app server: reads Claude Code sessions (desktop app and terminal), serves the console API.

Standard library only. Python 3.10 or later. The server only reads the
desktop app's files, the session registry and the CLI transcripts; it never
writes them.
"""

API = 1
APP = "chief-of-staff"

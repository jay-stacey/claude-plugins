"""Chief of Staff app server: reads Claude desktop sessions, serves the console API.

Standard library only. Python 3.10 or later. The server only reads the
desktop app's files and the CLI transcripts; it never writes them.
"""

API = 1
APP = "chief-of-staff"

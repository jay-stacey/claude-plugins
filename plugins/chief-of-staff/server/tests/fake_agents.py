"""Stands in for `claude agents --json` in tests: prints the rows in the file
named by the first argument. A file holding FAIL exits 1."""
import sys

text = open(sys.argv[1], encoding="utf-8").read()
if text.strip() == "FAIL":
    sys.exit(1)
sys.stdout.write(text)

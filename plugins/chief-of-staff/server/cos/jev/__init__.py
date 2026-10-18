"""Jev: a small, fast decision step that advises the Chief before it acts.

For each request Jev suggests the model a new session should use, whether to
start a new session or let the Chief do the work, and whether background work
is needed. Rules answer at once; a local or hosted model may refine the answer
within a short cap. The answer is advice: Jay's words and the Chief win.
"""

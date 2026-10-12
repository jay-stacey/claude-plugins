# Performance checks

Report a performance finding only with a realistic data size and path in mind. "Could be faster"
with no load where it matters is not a finding.

## Data access
- N+1: a query or remote call inside a loop over rows or items. Batch or join instead.
- Unbounded reads: list endpoints or jobs that load all rows; require paging or streaming.
- Missing index for a new filter, sort or join on a table the overlay or spec marks as large.
- Selecting all columns or large blobs when a few fields are needed on a hot path.
- Transactions held open across remote calls or user waits.

## Compute and memory
- Quadratic loops over inputs that can be large (nested scans, repeated list searches).
- Building large strings or arrays in memory where a stream fits.
- Repeated expensive work (parsing, regex compile, crypto) inside a loop.

## Network
- Outbound calls without a timeout; retries without backoff or limit.
- Sequential remote calls that are independent and could run together, on a hot path.
- Large payloads with no compression or field selection where the repo pattern has them.

## Frontend
- Re-rendering large lists without keys or virtualisation where the design shows long lists.
- Loading heavy dependencies for a small feature; images without size limits.
- Work on every keystroke without debounce where it calls the server.

## Measuring
- A claim of improvement needs a recorded before and after measurement (`evidence-rules`).
- If not measured, the finding says "risk" and the expected scale, not a number.

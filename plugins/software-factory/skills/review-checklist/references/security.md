# Security checks

For each finding give: category, exploit path (who, how, what they gain), fix, and a local test
that would prove the fix. Never probe a non-local target. Never print a secret you find: cite
`file:line` and the type of secret only.

## OWASP Top 10 (2021) map

| Category | Look for in the diff |
|---|---|
| A01 Broken access control | New entry point without an authorisation check; check done on the client only; object id from the request used without an ownership check (IDOR); missing deny-by-default |
| A02 Cryptographic failures | Home-made crypto; weak hashes for passwords (anything but a slow password hash); secrets or personal data sent or stored without encryption; hard-coded keys |
| A03 Injection | String-built SQL, shell commands, templates, LDAP or NoSQL queries from input; unescaped output into HTML (XSS) |
| A04 Insecure design | Missing rate limit on login or costly endpoints; trust in client-supplied prices, roles or ids; no abuse case in the spec |
| A05 Security misconfiguration | Debug mode on; verbose errors with stack traces to users; permissive CORS; default credentials; missing security headers the overlay requires |
| A06 Vulnerable components | New or upgraded dependency with known advisories, abandoned, or with an unfit licence; lockfile changes not explained by the task |
| A07 Identification and authentication failures | Session or token not invalidated on logout or password change; tokens in URLs or logs; weak reset flow |
| A08 Software and data integrity failures | Unsafe deserialisation of input; unsigned or unchecked downloads or updates; CI changes that run untrusted code |
| A09 Logging and monitoring failures | Security events (login fail, permission denied) not logged; personal data or secrets logged |
| A10 Server-side request forgery | Server fetches a URL or host taken from input without an allow list |

## Secrets
- No keys, tokens, passwords, connection strings or private certificates in code, config, tests,
  fixtures, docs, logs or commit history of the branch.
- Config reads secrets from the environment or the repo's secret mechanism named in the overlay.
- `.env*`, `*.pem`, `*.key` are not added to the repo.

## Input handling
- Validate type, length, range and format at the boundary; reject, do not "fix", bad input.
- File uploads: size limit, type check by content, stored outside the web root, random names.
- Paths built from input are normalised and checked against an allowed base (traversal).
- Parsers (XML, YAML, archives) configured safely (no external entities, zip-slip checks, size caps).

## Data deletion and retention
- Deletes are scoped (no missing WHERE), authorised, and logged.
- Soft versus hard delete matches the constitution; personal data deletion is complete
  (backups, caches, search indexes noted).
- Destructive migrations are flagged `destructive` in the handoff.

## Dependencies
- Each new package is needed for the task and listed in the spec.
- Maintained (recent releases), widely used, licence compatible with the constitution.
- Check known advisories with web search when the tool is available; otherwise say "not verified".
- Install scripts or post-install hooks noted.

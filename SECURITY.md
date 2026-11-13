# Security policy

## Operational boundaries

Run only with accounts you own and are authorized to use. This is an unofficial gateway; Google may change or restrict the upstream service at any time. No entitlement, subscription restriction, consent, MFA or attestation bypass is provided. Review applicable service terms before use.

Gemini main-service terms acceptance requires an explicit user choice. Login defaults to OAuth only; the adjacent consent switch is transient and captured only for that attempt. Manual per-account acceptance independently requires `{confirmed: true}` through the authenticated same-origin admin cookie/CSRF boundary. No startup, render or batch acceptance occurs. Existing receipts are preserved; missing local evidence is shown as “Not confirmed,” not proof of the official App's current state. Terms acceptance never substitutes for model-access verification.

The gateway entry point is `src/gateway-server.mjs`.

- State defaults to `~/.gemini-app2api`; use a dedicated `GATEWAY_DATA_DIR` for isolated operation.
- State directory permissions are enforced as `0700` and state files as `0600`; refresh credentials and the explicit OAuth client profile are local sensitive state. Access tokens stay in memory. Protect backups and host access; filesystem permissions are not disk encryption.
- Runtime admin passwords come only from an operator-owned untracked `.env` or environment variable `GATEWAY_ADMIN_PASSWORD` and are checked against an ephemeral scrypt hash. Existing legacy private-state hashes are load-compatible but do not override the runtime setting. Never put real passwords in tracked source, examples, logs or Git history. Dotenv must be mode `0600`; process environment takes precedence.
- With no/empty password, the console skips password login only on a loopback listener and loopback public origin. Any local user or process able to reach that port may bootstrap admin access, so this mode assumes a trusted single-user host. HttpOnly/SameSite cookie sessions, exact Host/Origin and mutation CSRF checks remain; the public model API still requires its independent bearer key.
- Non-loopback binding or remote proxy origins require a configured admin password as well as explicit remote/TLS configuration. Do not expose a naked container port. The supplied all-bind container setup requires a password, even with loopback host publishing. Client API keys are random bearer secrets kept in `0600` private state alongside SHA-256 lookup digests (omitted from passive `GET /admin/api/keys`, diagnostics, and browser storage; revealed or copied only through explicit authenticated CSRF-protected `POST /admin/api/keys/:id/reveal` and scrubbed on revocation), separate from admin sessions.
- Default logs contain metadata only — never prompts, replies, tool arguments/results, OAuth URLs, credentials or raw upstream errors. Diagnostics exports omit account labels, keys and identities.
- Tools are model requests interpreted by the caller. Validate execution privileges at the caller too: the gateway is not a sandbox, approval system or tool executor. Prompt protocols cannot guarantee model compliance.
- The gateway never performs background history compaction or sends extra summary requests; full validated input is forwarded directly to the requested model.

## Reporting vulnerabilities

Do not post tokens, account files, raw captures or exploit payloads containing personal data in a public issue. Use [GitHub private vulnerability reporting](https://github.com/ShawTim/gemini-app2api/security/advisories/new) if enabled on the repository. Rotate exposed Google credentials and revoke gateway API keys before sharing a sanitized report.

No external penetration test, compliance certification or production SLA is claimed. Security fixes are documented in [CHANGELOG.md](CHANGELOG.md).

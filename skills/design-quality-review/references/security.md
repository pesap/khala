# Security Reference (S0–S3)

Load this reference when the diff contains auth checks, user input reaching
storage/network/filesystem, URL construction, secrets, tokens, permissions, or
deserialization of untrusted data.

## Review Priority Order

### S0: Exploitable Vulnerability

Presumptive blocker. Flag immediately.

- **Injection**: Untrusted input concatenated into SQL, shell commands, LDAP, OS
  commands, or other interpreted contexts without parameterization or escaping.
- **Auth bypass**: Authentication check moved, weakened, duplicated
  inconsistently, or skipped on an alternate path.
- **Path traversal**: User-controlled path reaching filesystem without
  canonicalization and sandboxing.
- **Secrets exposure**: API keys, tokens, passwords, or private keys logged,
  returned in responses, committed, or stored in plaintext.
- **Unsafe deserialization**: Deserializing untrusted data into objects that can
  execute code on construction (Python `pickle`, Java `ObjectInputStream`, Ruby
  `Marshal.load`, Node `vm.runInNewContext` with user input).
- **Server-side request forgery (SSRF)**: User-controlled URL fetched by the
  server without destination validation (can reach localhost, internal IPs,
  metadata services).
- **Unrestricted file upload**: User file written to a web-accessible path
  without content-type and extension validation.

### S1: Security Weakness with Plausible Attack Path

- **Missing authorization check**: Operation gated only on authentication, not
  on resource ownership or role.
- **Unvalidated redirect**: User-controlled redirect target without allowlist —
  open redirect.
- **Cross-site scripting (XSS)**: User text rendered in HTML without escaping at
  the output boundary.
- **Cross-site request forgery (CSRF)**: State-changing operation without
  anti-CSRF token or SameSite cookie.
- **Information disclosure**: Error messages, stack traces, or debug output
  exposing internal paths, versions, or configuration.
- **Missing rate limiting**: Auth endpoints, password reset, or
  resource-intensive operations without rate limiting.
- **Weak randomness**: Using `Math.random()`, `rand()`, or non-cryptographic
  PRNG for tokens, session IDs, or cryptographic nonces.
- **Timing attack**: String comparison for secrets/tokens using `==` instead of
  constant-time comparison.

### S2: Defense-in-Depth Gap

- Missing security headers (CSP, HSTS, X-Content-Type-Options) on web responses.
- Hardcoded cryptographic keys instead of key management.
- Missing audit logging for sensitive operations.
- Deprecated cryptographic algorithm (MD5, SHA1 for signatures, RC4).
- Cookie without `Secure`, `HttpOnly`, or `SameSite` flags.
- CORS configured with `*` and `credentials: true`.

### S3: Best-Practice Hardening

- Input validation could be stricter (length limits, character allowlists).
- Dependency with known CVE (not directly exploitable in this context).
- Logging of PII without justification.
- HTTP instead of HTTPS for internal services (low risk).

## Trust Boundary Analysis

For every data flow in the diff, identify trust boundaries:

1. **Where does data enter the system?** HTTP handlers, message queues, file
   reads, CLI args, env vars — these are untrusted.
2. **Where does data cross a privilege boundary?** User→admin, tenant→tenant,
   service→service with different auth.
3. **Where does data leave the system?** Responses, logs, external API calls,
   file writes — these are output boundaries where escaping/sanitization
   matters.

Flag any boundary that is missing validation, escaping, or authorization.

## What Not to Flag as Security

- Theoretical attacks requiring physical access or kernel compromise.
- "This could be more secure if rewritten in Rust" — language-choice arguments
  are not diff-level security findings.
- Missing features ("there's no audit log") — unless the change introduces a
  sensitive operation that should be audited.

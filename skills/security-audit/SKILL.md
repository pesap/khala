---
name: security-audit
description: Audit code for security vulnerabilities including OWASP Top 10 and secrets exposure. Use when users ask for security review, hardening, or risk triage before shipping.
---

# Security Audit

## Use when
When reviewing code for security vulnerabilities, or when a change touches authentication, authorization, input handling, or data storage.

## Avoid when
- Task is pure feature implementation with no security scope.
- User wants compliance/legal interpretation beyond code-level evidence.

## Instructions

1. **Injection attacks** — Check for SQL injection, command injection, LDAP injection, XPath injection. Look for unsanitized user input in queries or shell commands
2. **XSS** — Check for unescaped user input rendered in HTML. Look for `innerHTML`, `dangerouslySetInnerHTML`, template literals in HTML context
3. **Authentication & Authorization** — Verify auth checks on all protected endpoints. Look for missing middleware, broken access control, privilege escalation paths
4. **Secrets** — Scan for hardcoded API keys, passwords, tokens, connection strings. Check `.env` files aren't committed
5. **SSRF** — Check for user-controlled URLs in server-side requests without allowlist validation
6. **Insecure deserialization** — Flag `eval()`, `pickle.loads()`, `JSON.parse()` on untrusted input without validation
7. **Dependency risks** — Note if new dependencies are added without lockfile updates or if known-vulnerable versions are used
8. **Cryptography** — Flag weak algorithms (MD5, SHA1 for security), hardcoded IVs, ECB mode, custom crypto implementations
9. **Report** — All security findings are Critical or Warning severity. Include CWE references where applicable

## Output
- Findings with severity and exploitability context
- CWE/OWASP mapping when applicable
- Evidence (file/line or command output)
- Immediate remediation and follow-up hardening tasks

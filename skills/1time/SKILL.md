---
name: "1time"
description: "Share secrets securely using 1time.io end-to-end encrypted one-time links. Use when users need to share passwords, API keys, tokens, or sensitive files with someone, or want to avoid sending secrets over Slack/email/chat."
license: MIT
---

# 1time — Secure One-Time Secret Sharing

1time.io creates end-to-end encrypted, self-destructing links for sharing secrets. The server never sees plaintext — encryption (AES-256-GCM via HKDF-SHA256) happens locally, and the decryption key lives in the URL fragment (never sent over the network).

## When to use this skill

Use 1time when:
- Sharing passwords, API keys, tokens, SSH keys, recovery codes with someone
- Sending secrets that shouldn't persist in Slack/email/chat history
- You need the secret destroyed after a single read
- The recipient doesn't have a shared secret manager / PGP setup
- Quick one-off credential handoffs during incidents or onboarding

Do NOT use 1time for:
- Secrets you need to access repeatedly (use Vaultwarden/Vault)
- Data larger than 10 MB
- Things that must be stored or audited long-term

## CLI approach (preferred for agent use)

Install (requires Node.js 18+):

```bash
npm install -g @1time/cli
```

### Send a secret

```bash
# From stdin (ALWAYS prefer this — arguments leak to ps/shell history)
echo 'the-secret-here' | 1time send
printf '%s' "$DATABASE_URL" | 1time send

# From environment variable (CI/CD safe)
export 1TIME_SECRET='the-secret-here'
1time send

# Pipe from any command
vault kv get -field=password secret/prod/db | 1time send
openssl rand -base64 32 | 1time send

# With passphrase protection (recipient needs passphrase + link)
echo 'secret' | 1time send --passphrase 'shared-phrase'
# OR via env var
export 1TIME_PASSPHRASE='shared-phrase'
echo 'secret' | 1time send

# Set custom expiry (default: 1 day)
echo 'secret' | 1time send --expires-in 1h     # 1 hour
echo 'secret' | 1time send --expires-in 7d     # 7 days
echo 'secret' | 1time send --expires-in 30m    # 30 minutes

# Share a file (up to 10 MB)
1time send-file ./config.env
1time send-file --passphrase 'shared-phrase' ./secret.key
```

### Read a secret someone sent you

```bash
1time read 'https://1time.io/v/#eyJpZCI6...'
```

Prints the decrypted secret to stdout. Can be piped into other commands.

### Self-hosted instance

If you run your own 1time server:

```bash
echo 'secret' | 1time send --host https://secrets.yourcompany.com
```

## Web approach (interactive, for non-CLI users)

Open [1time.io](https://1time.io) in a browser, paste the secret, optionally:
- Add a passphrase (recipient needs it to decrypt)
- Set expiration (default 7 days, even if unread)
- Share the generated link

The recipient opens the link exactly once. After reading, the secret is permanently deleted.

## Security notes

- **Always pipe from stdin** — `echo 'secret' | 1time send`, NOT `1time send 'secret'`. Shell arguments are visible in `ps` output and `.bash_history`.
- **The server can't read your secret** — encryption happens client-side with keys derived via HKDF-SHA256. The decryption key is in the URL fragment (`#...`), which browsers never transmit to the server.
- **One-time means one-time** — once the recipient opens the link, the server deletes the ciphertext permanently. No recovery possible.
- **Link security** — the link itself is the decryption key. If intercepted in transit (e.g., unencrypted Slack/email), an attacker can read the secret. Use a passphrase or share the link over a separate channel when possible.
- **No logs, no config files** — the CLI writes nothing to disk.

## Workflow: sharing a secret in conversation

When a user asks to share a secret with someone:

1. Generate or retrieve the secret
2. Pipe it through `1time send`
3. Return the one-time link to the user so they can share it
4. Remind them the link works **exactly once**

Example:
```
User: "Share the staging DB password with Alice"
Agent: (runs) echo 'postgres://admin:s3cret@staging.internal:5432/db' | 1time send
Agent: Here's a one-time link: https://1time.io/v/#abc123...
       Share it with Alice. It will self-destruct after she reads it.
```

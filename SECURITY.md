**English** | [Русский](SECURITY.ru.md) | [Srpski](SECURITY.sr.md) | [日本語](SECURITY.ja.md)

# Security Policy

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `3.x` | :white_check_mark: |
| `< 3.0` | :x: |

---

## Reporting a Vulnerability

We take the security of **Tokio** seriously. If you discover a security vulnerability, **do not** report it in a public GitHub Issue, Pull Request, or discussion.

### Private Reporting Procedure

1. Open a **Private Vulnerability Report** via [GitHub Security Advisories](https://github.com/ValDagon/tokio/security/advisories).
2. Include enough detail to reproduce and assess the issue:
   - Category (secret leak, authentication bypass, IDOR/tenant isolation bug, prompt injection, XSS, SQL injection, etc.).
   - Affected component (`src/handlers/`, `src/endpoints/rpc.ts`, `src/lib/dal/`, `miniapp/`, `scripts/`, or build tooling).
   - Minimal reproduction steps or Proof-of-Concept (PoC).
   - Potential security impact.

### Response Timeline

- **Initial Acknowledgement**: Within 48 hours.
- **Triage & Assessment**: Within 5 business days.
- **Remediation & Disclosure**: Fixes are prepared privately and released to `main`, with credit to the reporter unless anonymity is requested.

---

## Security Architecture Highlights

- **BYOK Encryption at Rest (`src/lib/crypto.ts`)**: User-supplied Gemini API keys are encrypted using pure-TypeScript RFC 8439 ChaCha20-Poly1305 with unique 96-bit nonces and HMAC-SHA256 verification.
- **Mini App Authentication (`src/endpoints/rpc.ts`, `src/lib/auth.ts`)**: Production RPC requests validate Telegram WebApp `initData` signatures (`HMAC-SHA256`) and `auth_date` freshness.
- **Tenant Scoping (`src/lib/dal/`)**: Every user-scoped database read and write filters explicitly by `user_id` / `telegram_id`, with optional fail-closed whitelist access control (`ADMIN_IDS`, `BETA_WHITELIST`).
- **3-Layer Leak Prevention**: Private overlays (`overlay/`), local secret files, and `.forbidden-strings.local` are excluded via `.gitignore`, verified locally by `.githooks/pre-push` (`scripts/check-leaks.mjs` + `gitleaks`), and enforced in GitHub Actions CI.

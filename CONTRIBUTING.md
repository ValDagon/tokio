**English** | [Русский](CONTRIBUTING.ru.md) | [Srpski](CONTRIBUTING.sr.md) | [日本語](CONTRIBUTING.ja.md)

# Contributing to Tokio

Thank you for your interest in contributing to **Tokio**! Please read [`AGENTS.md`](AGENTS.md) alongside this guide before submitting a pull request.

---

## 1. Core vs. Overlay Boundary

Tokio is structured as a reusable open-source core paired with private declarative overlays:

- **Belongs in Core (`src/`, `miniapp/src/`, `locales/`, `tests/`)**: neutral mechanisms — agent tools, interfaces, SQLite schema/DAL, bug fixes, tests, extension points, and declarative feature flags.
- **Belongs in Overlay (`overlay/` or `OVERLAY_DIR`)**: instance taste — custom branding, personal prompts, persona tone, coaching style, private bank aliases, and personal identifiers.
- **Contested behavior**: place behind a toggle in `manifest.features` ([`docs/system/OVERLAY-SPEC.md`](docs/system/OVERLAY-SPEC.md)).

Never submit personal prompts, real Telegram user IDs, personal emails, deployment URLs, or private bank names in PRs.

---

## 2. Local Development Setup

Requires **Node.js 22+** and `npm`:

```bash
git clone https://github.com/ValDagon/tokio.git
cd tokio
npm install
(cd miniapp && npm install)
```

- `npm install` configures `git config core.hooksPath .githooks`, enabling `.githooks/pre-push` automatically.
- Optional: install `gitleaks` (`brew install gitleaks`) for local secret scanning before every push.

---

## 3. Mandatory Verification Gates

Every pull request must pass all checks locally with `exit code 0`:

```bash
# 1. Leak & hygiene guard
npm run check:leaks

# 2. Backend / V8 isolate core
npm run typecheck
npm test
npm run build        # verifies <= 100 modules and valid bundle graph

# 3. Mini App
cd miniapp
npm run lint
npm test
npm run build
```

---

## 4. Localization Policy (4 Locales)

Tokio ships in **4 locales**: `en` (English), `ru` (Russian), `sr` (Serbian Latin with diacritics `č, ć, đ, š, ž`), and `ja` (polite Japanese `です/ます`).

- When adding or modifying user-facing strings, update all 4 files in `locales/{en,ru,sr,ja}.json` and/or `miniapp/src/i18n/locales/{en,ru,sr,ja}.json`.
- Locale completeness tests enforce key parity across all 4 languages.

---

## 5. Pull Request Guidelines

- Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Keep PRs focused and include tests for new behavior or bug fixes.
- Use [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) and ensure CI (`backend`, `miniapp`, and `security-leaks`) passes.
- By submitting a contribution, you agree that your work will be licensed under the [Apache License, Version 2.0](LICENSE) (see also [`NOTICE`](NOTICE) and [`CONTRIBUTORS.md`](CONTRIBUTORS.md)).

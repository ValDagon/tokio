**English** | [Русский](README.ru.md) | [Srpski](README.sr.md) | [日本語](README.ja.md)

# Tokio

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](tsconfig.json)
[![Telegram Serverless](https://img.shields.io/badge/platform-tgcloud.ai-blueviolet.svg)](https://tgcloud.ai/)
[![SQLite](https://img.shields.io/badge/SQLite-24%20Tables-003B57.svg)](src/lib/db/tables.ts)
[![Mini App](https://img.shields.io/badge/Mini%20App-React%2019-61DAFB.svg)](miniapp/)
[![Locales](https://img.shields.io/badge/i18n-EN%20%7C%20RU%20%7C%20SR%20%7C%20JA-informational.svg)](locales/)
[![Tests](https://img.shields.io/badge/tests-1912%20%2B%2036%20passed-brightgreen.svg)](tests/)

**Tokio** is an open-source personal AI assistant core engineered natively for **Telegram Serverless** (`tgcloud.ai`). It runs inside V8 isolates on an embedded 24-table SQLite database, ships a 5-tab **React 19 Telegram Mini App**, supports **4 languages out of the box** (`EN`, `RU`, `SR-Latn`, `JA`), and separates reusable core mechanics from instance personality through **declarative Level 1 Overlays**.

> [!TIP]
> **Works immediately on clone:** If you do not provide a private `overlay/` folder, Tokio automatically falls back to [`example/overlay/`](example/overlay/) and builds a complete working assistant with a localized starter demo seed ([`example/seed/demo.json`](example/seed/demo.json)).

---

## Architecture

```mermaid
flowchart LR
  TG["Telegram Bot & Mini App<br/>(React 19 + Vite SPA)"] -->|Webhook & POST /api/rpc| ISO["Telegram Serverless V8 Isolate<br/>(tgcloud.ai, <= 100 modules)"]
  ISO --> AGENT["Agent Engine (54 Tools)<br/>STT · Vision OCR · Financial Parser"]
  ISO --> OVERLAY["Compiled Overlay & i18n<br/>(EN · RU · SR-Latn · JA)"]
  ISO --> CRYPTO["Pure-TS Crypto<br/>ChaCha20-Poly1305 BYOK"]
  AGENT --> DAL["Tenant-Scoped DAL<br/>(user_id isolation)"]
  DAL --> DB[("Platform SQLite<br/>24 Tables")]
```

For full runtime and module details, see [`docs/system/ARCHITECTURE.md`](docs/system/ARCHITECTURE.md) and [`docs/system/OVERLAY-SPEC.md`](docs/system/OVERLAY-SPEC.md).

---

## Core Highlights

- **Single-Source SQLite Schema (`24` Tables)**: Defined once in [`src/lib/db/tables.ts`](src/lib/db/tables.ts), compiled to platform DSL (`src/schema.ts`) for `tgcloud migrate` and SQL DDL (`src/lib/db/ddl.ts`) for local Vitest suites.
- **Declarative Level 1 Overlays**: Keep personal prompts, persona styles, account aliases, feature flags, and Mini App themes cleanly separated in `overlay/` (gitignored) or `OVERLAY_DIR`. See [`example/README.md`](example/README.md).
- **4-Locale Support (`EN`, `RU`, `SR-Latn`, `JA`)**: Localized bot replies, keyboards, onboarding wizard, prompts, Mini App UI, and starter demo seed (`locales/*.json` + `miniapp/src/i18n/`).
- **54 Native Agent Tools**: Modular toolset covering tasks & recurring calendar events (`item_type: 'task' | 'event'`), multicurrency finances & debt queues, omnivorous Second Brain notes & knowledge graph, medications, runway forecasting, triage, diary, and soft-delete trash.
- **Deterministic Financial Parser & Rollback**: Parses expenses, income, transfers, and multi-account balances across text, voice STT, and receipt/balance photos with one-tap `[Undo]` / `/undo`.
- **Pure-TS ChaCha20-Poly1305 BYOK Encryption**: Zero native C++ dependencies; users can bring their own encrypted Gemini API key while honoring optional instance spend limits and open or fail-closed whitelist access modes.
- **3-Layer Leak Protection**: Private `overlay/` and `.forbidden-strings.local` are gitignored, `.githooks/pre-push` + `scripts/check-leaks.mjs` scan files and git history, and GitHub Actions runs `gitleaks` + leak checks on every push and pull request.

---

## Quick Start

### Prerequisites

- **Node.js 22+** and `npm`
- Optional: `gitleaks` (`brew install gitleaks`) for local pre-push secret scanning
- Optional: `@tgcloud/cli` token from BotFather (`Serverless -> CLI Access`) for deployment

### 1. Clone and Install

```bash
git clone https://github.com/ValDagon/tokio.git
cd tokio
npm install
(cd miniapp && npm install)
```

`npm install` configures `git config core.hooksPath .githooks` so the pre-push leak check runs automatically before pushing.

### 2. Verify Locally (Zero-Config Fallback)

Without creating any private files, Tokio compiles [`example/overlay/`](example/overlay/) and runs all checks against an in-memory SQLite engine:

```bash
npm run check:leaks
npm run typecheck
npm test
npm run build

cd miniapp
npm run lint
npm test
npm run build -- --outDir ../miniapp-dist --emptyOutDir
```

### 3. Deploy to Telegram Serverless (`tgcloud.ai`)

```bash
npx tgcloud push && npx tgcloud migrate --yes
```

Or use the verification and deployment script:

```bash
APP_URL=https://<your-app>.tgcloud.ai ./.agents/scripts/deploy.sh
```

---

## Customizing with Overlays

To customize branding, prompts, financial defaults, or feature flags without modifying core source files:

1. Copy the starter overlay into the gitignored `overlay/` directory:
   ```bash
   cp -R example/overlay overlay
   ```
2. Edit `overlay/manifest.json` and `overlay/prompts/{ru,en,sr,ja}/*.md`.
3. Rebuild and deploy (`npm run build`, or point `OVERLAY_DIR=/path/to/overlay` at any external directory).

Full walkthrough: [`example/README.md`](example/README.md) · [`docs/system/OVERLAY-SPEC.md`](docs/system/OVERLAY-SPEC.md).

---

## Contributing, Security & License

- **Contributing**: See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md) for the Core vs. Overlay boundary rule and verification checklist.
- **Security**: Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/ValDagon/tokio/security/advisories). See [`SECURITY.md`](SECURITY.md).
- **Authors & Contributors**: See [`CONTRIBUTORS.md`](CONTRIBUTORS.md) and [`NOTICE`](NOTICE).
- **License**: Licensed under the [Apache License, Version 2.0](LICENSE).

# Tokio Core Architecture

Tokio is an open-source personal AI assistant core built for **Telegram Serverless** (`tgcloud.ai`). It runs entirely inside a V8 isolate backed by an embedded SQLite database and serves a React 19 + Vite Telegram Mini App from the same origin.

---

## 1. Runtime & Platform Constraints

- **V8 Isolate Execution (`tgcloud.ai`)**:
  - `build.mjs` transpiles `src/**/*.ts` into `tgcloud/**/*.js` using `esbuild` while bundling `src/schema.ts`, `src/handlers/{message,callback_query}.ts`, `src/lib/overlay.ts`, `src/lib/i18n.ts`, and `src/lib/agent/tools/index.ts`.
  - **Module Cap**: `MODULE_CAP = 100` (currently 91 deployed `.js` modules in `tgcloud/`). `build.mjs` fails fast if the emitted module count exceeds 100, and `scripts/check_bundle_graph.mjs` verifies that every relative import inside `tgcloud/` resolves.
  - **Zero Native C++ Addons / Zero Runtime `node:fs`**: All cryptography, HTTP helpers, and runtime assets execute purely in TypeScript/JavaScript inside the isolate.
  - **No Background Daemons**: Persistent timers (`setTimeout`/`setInterval`) are unavailable across requests. Scheduled reminders and maintenance tasks run opportunistically via `due_jobs` (`src/lib/dal/due_jobs.ts`) on incoming updates and RPC calls.

---

## 2. Single-Source SQLite Schema & Multi-Tenant DAL

- **Schema Definition**: `src/lib/db/tables.ts` defines all **24 tables** (and their indexes) once:
  - `users`, `task_categories`, `task_subcategories`, `tasks`
  - `accounts`, `doc_chapters`, `fin_categories`, `transactions`, `budgets`, `liabilities`, `fx_rates`
  - `notes`, `entities`, `mentions`, `relations`
  - `messages`, `agent_state`, `llm_usage`
  - `medications`, `medication_logs`
  - `due_jobs`, `kv`, `evolution_items`, `feedback`
- **Dual Adapters**:
  - `src/schema.ts` compiles `tables.ts` into the platform DSL (`tgcloud/schema.js`) for `npx tgcloud migrate`.
  - `src/lib/db/ddl.ts` compiles the same definitions to SQL DDL for local in-memory Vitest runs (`better-sqlite3`).
- **Tenant Isolation (`src/lib/dal/`)**:
  - All domain reads and writes (`tasks`, `finances`, `fx`, `notes`, `medications`, `users`, `docs`, `inbox`, `agentState`, `due_jobs`, `misc`) go through DAL functions that enforce `user_id` / `telegram_id` scoping.

---

## 3. Agent Runtime & Core Engines

- **ReAct Engine (`src/lib/agent/engine.ts`)**: Native tool-calling loop with **54 registered tools** (`src/lib/agent/tools/index.ts` across `tasks`, `finances`, `notes`, `medications`, `runway`, `triage`, `diary`, `reasoning`, `systemDocs`, `trash`) and persistent checkpoints in `agent_state`.
- **Pure-TS BYOK Crypto (`src/lib/crypto.ts`, `src/lib/vendor/crypto.ts`)**: RFC 8439 ChaCha20-Poly1305 encryption and HMAC-SHA256 key handling for user-provided Gemini API keys (`/key` when enabled).
- **Multimodal Processing**: Voice STT (`src/lib/stt.ts`) and receipt/balance screenshot OCR (`src/lib/vision.ts`).
- **Deterministic Financial Parser (`src/lib/financial-parser.ts`)**: Parses expenses, income, transfers, and balances with instant rollback (`/undo` and inline callback buttons).
- **Tasks vs. Events & Overload Features**: Distinguishes actionable `task` items from calendar `event` items (`autoAdvancePastEvents`) and exposes optional focus/overload helpers gated by overlay feature flags (`overloadShield`, `microFocusTriage`, `calmModeUi`).

---

## 4. Declarative Overlays & 4-Locale i18n

- **Level 1 Overlay (`docs/system/OVERLAY-SPEC.md`)**: Separates reusable core mechanisms from instance branding, prompts, financial account aliases, Mini App themes, and feature flags.
- **Zero-Config Fallback**: `scripts/compile-runtime-assets.mjs` reads `OVERLAY_DIR` or `<repo>/overlay/manifest.json`, and automatically falls back to `example/overlay/` when no custom overlay is present.
- **4-Locale Support (`locales/{ru,en,sr,ja}.json`, `miniapp/src/i18n/`)**: Russian, English, Serbian (Latin), and Japanese (polite) across bot responses, prompts, Mini App UI, and starter demo seed (`example/seed/demo.json`).

---

## 5. Telegram Mini App & Security Boundaries

- **Mini App (`miniapp/` -> `miniapp-dist/`)**: React 19 + Vite SPA served as static assets via `tgcloud.jsonc`, talking to `POST /api/rpc` (`src/endpoints/rpc.ts`) and `src/endpoints/getFastState.ts`.
- **Authentication & Access Control (`src/lib/auth.ts`, `src/endpoints/rpc.ts`)**:
  - Telegram WebApp `initData` HMAC-SHA256 validation (`auth_date` check).
  - Supports open multi-tenant registration (`ADMIN_IDS = []`, `BETA_WHITELIST = []`) or fail-closed private whitelist mode.
- **3-Layer Leak Protection**:
  1. Private overlays (`overlay/`), secrets (`src/lib/secrets.ts`), and local forbidden patterns (`.forbidden-strings.local`) are excluded via `.gitignore`.
  2. Local pre-push gate (`.githooks/pre-push`) runs `scripts/check-leaks.mjs --git-history` and `gitleaks` (`.gitleaks.toml`).
  3. GitHub Actions CI (`.github/workflows/ci.yml`) runs `gitleaks` and `npm run check:leaks:history` on every push and pull request.

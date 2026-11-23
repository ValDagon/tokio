# Project Guidelines: Tokio

Tokio is an open-source personal AI assistant core built in **TypeScript** and **SQLite** for **Telegram Serverless (`tgcloud.ai`)**, paired with a **React 19 + Vite** Telegram Mini App (`miniapp/`) and a declarative **Level 1 Overlay** system (`docs/system/OVERLAY-SPEC.md`).

---

## 1. Core vs. Overlay Rule

Every change in this repository must respect the separation between reusable core and instance customization:

- **Core (`src/`, `miniapp/src/`, `locales/`, `tests/`)**: Neutral mechanisms — agent tools, interfaces, SQLite DAL, bug fixes, tests, extension points, and declarative feature flags.
- **Overlay (`overlay/` gitignored, `OVERLAY_DIR`, or `example/overlay/`)**: Instance taste — brand name, persona tone, coaching style, priorities, account aliases/themes, reserve amount, and default prompts.
- **Contested Behavior**: Expose a declarative boolean/number toggle under `manifest.features` rather than hardcoding instance preferences in core code.

---

## 2. Three-Tier Agent Boundaries

- **ALWAYS**:
  - Run `npm run check:leaks`, `npm run typecheck`, `npm test`, and `npm run build` before finishing backend/core changes.
  - Run `cd miniapp && npm run lint && npm test && npm run build` before finishing Mini App changes.
  - Keep the SQLite schema single-source in `src/lib/db/tables.ts` (adapted by `src/schema.ts` for `tgcloud migrate` and `src/lib/db/ddl.ts` for Vitest).
  - Enforce tenant scoping (`WHERE user_id = ?` / `WHERE telegram_id = ?`) in every `src/lib/dal/*` function.
  - Keep all 4 locales (`en`, `ru`, `sr`, `ja`) synchronized when modifying user-facing strings in `locales/*.json` or `miniapp/src/i18n/locales/*.json`.
  - Keep emitted `tgcloud/` modules at or below `MODULE_CAP = 100` (enforced by `build.mjs` and verified by `scripts/check_bundle_graph.mjs`).

- **ASK FIRST**:
  - Changing the project license or adding runtime/build dependencies.
  - Modifying SQLite schema tables in `src/lib/db/tables.ts` or running migrations.
  - Adding new `.ts` files under `src/` that push `tgcloud/` closer to `MODULE_CAP = 100`.
  - Changing the Level 1 Overlay `manifest.json` schema (`schemaVersion`).

- **NEVER**:
  - Commit secrets, API keys, `.env`, `src/lib/secrets.ts`, `tgcloud/lib/secrets.js`, `.tgcloud/`, `overlay/`, or personal identifiers (real user IDs, emails, private bank names, deployment URLs).
  - Hardcode `tgcloud.ai` deployment URLs, personal Telegram user IDs, or private handles in core code or tests.
  - Introduce native C++ addons or runtime `node:fs` calls inside `src/` (V8 isolate requirement; all cryptography in `src/lib/crypto.ts` and `src/lib/vendor/crypto.ts` must stay pure TypeScript).
  - Bypass `npm run check:leaks` or `.githooks/pre-push`.
  - Run `DROP TABLE`, `TRUNCATE`, or destructive bulk deletes without explicit confirmation.

---

## 3. Environment & Verification Commands

Requires **Node.js 22+** and `npm`:

```bash
# Leak & hygiene check
npm run check:leaks
npm run check:leaks:history

# Backend / V8 isolate core
npm run typecheck      # pretypecheck generates secrets stub & overlay/i18n modules
npm test               # Vitest suite against in-memory SQLite
npm run build          # esbuild -> tgcloud/ + MODULE_CAP check + bundle graph check

# Mini App
cd miniapp
npm run lint           # oxlint
npm test               # Vitest unit/i18n tests
npm run build          # tsc -b && vite build -> ../miniapp-dist

# Deploy to Telegram Serverless (optional APP_URL for explicit Mini App API origin)
npx tgcloud push && npx tgcloud migrate --yes
```

---

## 4. Key Architecture & File Layout

- `src/lib/db/tables.ts` & `src/schema.ts`: Single-source 24-table SQLite schema (`users`, `tasks`, `accounts`, `transactions`, `liabilities`, `notes`, `entities`, `relations`, `medications`, `due_jobs`, `agent_state`, `feedback`, etc.).
- `src/lib/dal/`: Tenant-scoped SQLite Data Access Layer.
- `src/lib/agent/`: Native ReAct loop (`engine.ts`, `prompts.ts`, `constants.ts`) and 60 tools (`tools/index.ts`; the count is locked by `tests/agent/boot.test.ts`).
- `src/handlers/`: Telegram update handlers (`message.ts`, `callback_query.ts`, `router.ts`, `ingest.ts`, `onboarding.ts`, `keyboards.ts`, `formatting.ts`).
- `src/endpoints/rpc.ts`: Unified RPC gateway for the Mini App (`POST /api/rpc`) with Telegram `initData` HMAC-SHA256 validation.
- `src/lib/overlay.ts` & `src/lib/i18n.ts`: Runtime entrypoints compiled from `overlay/` (or `example/overlay/`) and `locales/*.json` by `scripts/compile-runtime-assets.mjs`.
- `src/lib/crypto.ts`: Pure-TS RFC 8439 ChaCha20-Poly1305 & HMAC-SHA256 for encrypted BYOK API keys.
- `src/lib/auth.ts`: Access control (`ADMIN_IDS`, `BETA_WHITELIST`, open multi-tenant or fail-closed private mode).
- `miniapp/src/`: React 19 + Vite Mini App (5 tabs: Today, Tasks, Finances, Notes, System) with 4 locales.
- `scripts/check-leaks.mjs` & `.gitleaks.toml`: 2-layer leak scanner + pre-push/CI enforcement.

---

## 5. V8 Isolate Coding Invariants

1. **Relative `.js` ESM Imports**: Imports inside `src/` must use `.js` specifiers (`./foo.js`) for the V8 isolate runtime.
2. **No `lib/` → `handlers/` Imports**: `build.mjs` emits only `handlers/message.js` and `handlers/callback_query.js`; helpers in `handlers/` are bundled inside them. `src/lib/` must never import from `src/handlers/`.
3. **No Persistent Timers**: Background work (reminders, digests, maintenance) runs opportunistically via `due_jobs` (`src/lib/dal/due_jobs.ts`) on incoming webhook or RPC traffic.
4. **No Filesystem Access in Runtime**: All overlay prompts, manifest settings, demo seeds, and locale dictionaries are compiled at build time into `*.generated.ts`.

---

## 6. Cross-Harness Agent Handoff & Core/Overlay Workflow

- **Cold-Start Read Order (OpenCode, Antigravity, Claude Code, Codex, Gemini CLI, or any model)**:
  1. `AGENTS.md` (core boundaries, gates, and V8 isolate invariants)
  2. `docs/system/INDEX.md` (documentation map)
  3. `docs/system/ARCHITECTURE.md` (runtime layout, module cap, SQLite schema, 60-tool engine)
  4. `docs/system/OVERLAY-SPEC.md` (Level 1 Overlay manifest, prompt compilation, feature flags)
- **Branch & PR Workflow**:
  - Develop core mechanics (tools, bug fixes, Mini App features, i18n, feature flags) on a feature branch and submit a PR to `main` so maintainers can review cleanly.
  - Downstream private instances consume this repository either as a vendored copy of `core/` or as a git submodule, and keep all instance-specific branding, prompts, and feature toggles inside their own `overlay/` (or `OVERLAY_DIR`).
  - Before submitting or handing off work between models/harnesses, run `npm run check:leaks:history`, `npm run typecheck`, `npm test`, `npm run build`, and Mini App `npm run lint && npm test && npm run build`, and leave the branch clean with a concise status summary.

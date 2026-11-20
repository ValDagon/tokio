---
name: project-deploy
description: >-
  Standardized deployment and release runbook for Tokio on Telegram Serverless
  (tgcloud.ai): leak checks, typecheck, tests, bundle graph verification,
  Mini App build, and tgcloud push/migrate.
license: Apache-2.0
metadata:
  version: v3
---

# Tokio Deployment & Release Runbook

Tokio runs inside a **Telegram Serverless (`tgcloud.ai`)** V8 isolate: the bot
handlers, RPC endpoints, embedded SQLite database, and static Mini App (`miniapp-dist/`)
are served from the same `tgcloud` deployment.

---

## 1. Pre-Flight Verification (Mandatory Gates)

Run from the repository root. Every command must exit `0`:

```bash
npm run check:leaks      # Layer 1 (+ Layer 2 if configured) leak scan
npm run typecheck        # tsc --noEmit
npm test                 # Vitest suite
npm run build            # Transpile/bundle -> tgcloud/ + module cap (<= 100) + graph check

cd miniapp && npm run lint && npm test \
  && npm run build -- --outDir ../miniapp-dist --emptyOutDir
```

If your Mini App needs an explicit API origin, pass `VITE_API_BASE_URL=https://<your-app>.tgcloud.ai` (or set `APP_URL` when using `.agents/scripts/deploy.sh`).

### Selecting an Overlay

- By default, `build.mjs` compiles `<repo>/overlay/manifest.json` when present and falls back to `example/overlay/`.
- To build with an external private overlay directory:

```bash
OVERLAY_DIR=/path/to/your-overlay npm run build
```

---

## 2. Automated Deployment Script

```bash
APP_URL=https://<your-app>.tgcloud.ai ./.agents/scripts/deploy.sh
```

The script sequentially:
1. Runs `npm run check:leaks`.
2. Runs `npm run typecheck`, `npm test`, and `npm run build` (including `check_bundle_graph.mjs` and the `MODULE_CAP = 100` check).
3. Lints, tests, and builds the Mini App into `miniapp-dist/`.
4. Deploys code and static assets via `npx tgcloud push && npx tgcloud migrate --yes`.

Note: `deploy.sh` does not commit or push git changes automatically; keep private `overlay/` and `tgcloud/lib/secrets.js` outside git.

---

## 3. Manual Deployment

```bash
npm run check:leaks && npm run typecheck && npm test && npm run build
(cd miniapp && npm run lint && npm test && npm run build -- --outDir ../miniapp-dist --emptyOutDir)
npx tgcloud push && npx tgcloud migrate --yes
```

`npx tgcloud push` uploads `tgcloud/` and `miniapp-dist/` as currently built on disk; it never triggers a build itself. `npx tgcloud migrate --yes` explicitly applies pending `tgcloud/schema.js` changes.

---

## 4. Post-Deployment Smoke Tests

```bash
# Static Mini App shell is served
curl -s -I https://<your-app>.tgcloud.ai

# RPC endpoint rejects unauthenticated requests
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<your-app>.tgcloud.ai/api/rpc \
  -H 'Content-Type: application/json' -d '{"path":"/api/tasks","method":"GET"}'
```

Expected: `HTTP/2 200` for the static site and `401` for an unauthenticated `/api/rpc` call.

#!/usr/bin/env bash
# Deploy Tokio core (+ active overlay) to Telegram Serverless (tgcloud.ai).
# Set APP_URL (e.g. https://your-app.tgcloud.ai) if the Mini App uses an explicit API base URL;
# otherwise Vite builds with relative origin paths.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

APP_URL="${APP_URL:-}"

echo "=========================================="
echo "Tokio: Verification & tgcloud Deployment"
echo "=========================================="

echo ""
echo "▶ 1/4: Leak scan..."
npm run check:leaks

echo ""
echo "▶ 2/4: Typecheck, backend tests, and tgcloud bundle..."
npm run typecheck
npm test
npm run build

echo ""
echo "▶ 3/4: Mini App lint, tests, and production build (miniapp-dist/)..."
(
  cd miniapp
  npm run lint
  npm test
  if [ -n "$APP_URL" ]; then
    VITE_API_BASE_URL="$APP_URL" npm run build -- --outDir ../miniapp-dist --emptyOutDir
  else
    npm run build -- --outDir ../miniapp-dist --emptyOutDir
  fi
)

echo ""
echo "▶ 4/4: Deploying to Telegram Serverless (tgcloud)..."
npx tgcloud push && npx tgcloud migrate --yes

echo ""
echo "=========================================="
echo "Deployment completed successfully!"
if [ -n "$APP_URL" ]; then
  echo "Target URL: $APP_URL"
fi
echo "=========================================="

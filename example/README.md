# Tokio Example Overlay & Demo Seed

This directory provides the built-in **fallback overlay** (`example/overlay/`) and **localized demo seed** (`example/seed/demo.json`) for Tokio.

## Automatic Fallback Behavior

Out of the box, if `<repo>/overlay/manifest.json` does not exist, `scripts/compile-runtime-assets.mjs` automatically compiles `example/overlay/` into `src/lib/overlay.generated.ts`. You can run typecheck, tests, and builds immediately after cloning without creating any private files.

## Creating Your Custom Overlay

1. Copy the example overlay to the gitignored `overlay/` directory:

   ```bash
   cp -R example/overlay overlay
   ```

   Alternatively, keep your overlay outside the repository and point to it with `OVERLAY_DIR`:

   ```bash
   OVERLAY_DIR=/path/to/my-overlay npm run build
   ```

2. Edit `overlay/manifest.json`:
   - `brand`: set your `assistantName`, `localizedNames`, `backupPrefix`, `supportContact`, `miniAppUrl`, and `accessDeniedMessage`.
   - `defaults`: configure `timezone`, `baseCurrency`, `summaryTime`, `supportedCurrencies`, and `inboxCurrencies`.
   - `features`: toggle instance capabilities (`spendLimitEnabled`, `spendLimitUsd`, `onboardingWizard`, `byokCommand`, `feedbackEnabled`, `overloadShield`, `microFocusTriage`, `calmModeUi`, `publicOpenAccess`).
   - `finance`: define `accountAliases`, `defaultAccountByCurrency`, `genericCardAccountByCurrency`, and `reserveAmount`.
   - `miniapp`: customize `tabs` and `accountThemes`.
   - `prompts.personaStyles`: customize the four persona presets (`mentor`, `strategist`, `calm_partner`, `concise`).

3. Customize the Markdown prompts in `overlay/prompts/{ru,en,sr,ja}/{identity,mission,principles,classifier}.md`:
   - Use `{{assistantName}}` for the bot name.
   - Keep the JSON schema and `{{currencies}}` placeholder intact in `classifier.md`.

## Demo Seed Data

`example/seed/demo.json` contains neutral starter datasets (3 accounts, 1 monthly liability, 3 tasks, and 3 searchable notes) in `ru`, `en`, `sr`, and `ja`. It is compiled into the overlay bundle and accessed via `getDemoSeed(locale)` for onboarding and demo environments.

## Local Verification & Deployment

Run the full local verification suite:

```bash
npm run typecheck && npm test && npm run build
```

Deploy to Telegram Serverless (`tgcloud.ai`):

```bash
npx tgcloud push && npx tgcloud migrate --yes
```

For the full schema and architecture details, see [docs/system/OVERLAY-SPEC.md](../docs/system/OVERLAY-SPEC.md).

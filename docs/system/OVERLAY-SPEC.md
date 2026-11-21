# Level 1 Mod / Overlay Specification (`OVERLAY-SPEC`)

> **Scope**: Defines how Tokio separates its reusable open-source core from per-instance branding, prompts, financial defaults, Mini App themes, and feature flags — without duplicating codebases or leaking personal data.

---

## 1. Design Principles (Level 1 Declarative Overlay)

1. **Zero Executable Code**: An overlay contains **only** declarative data (`manifest.json` + Markdown prompt files). It never ships `.ts` or `.js` files, hooks, or custom SQL.
2. **Build-Time Compilation (Zero `node:fs` in Runtime)**: Telegram Serverless (`tgcloud.ai`) executes inside a V8 isolate with no filesystem access and a strict **100-module cap** (`MODULE_CAP = 100`). `scripts/compile-runtime-assets.mjs` compiles the active overlay at build time into `src/lib/overlay.generated.ts`, and `build.mjs` bundles `src/lib/overlay.ts` + `src/lib/overlay.generated.ts` into a **single** deployed module: `tgcloud/lib/overlay.js`.
3. **Automatic Fallback (Decision 13)**: A fresh clone of the repository builds, passes tests, and deploys immediately with zero manual setup. When `/overlay/manifest.json` does not exist, the compiler automatically falls back to `example/overlay/`.
4. **Private Overlay Isolation**: `/overlay/` and `src/lib/overlay.generated.ts` are listed in `.gitignore`. Personal branding, bank names, custom personas, and private support links stay strictly outside git history.

---

## 2. Directory Resolution Order

`scripts/compile-runtime-assets.mjs` resolves the active overlay directory in the following precedence order:

| Priority | Source | `OVERLAY_SOURCE` |
| :--- | :--- | :--- |
| 1 | Explicit `options.overlayDir` (programmatic call) | `'custom'` (or `'example'` if it resolves to `example/overlay`) |
| 2 | `OVERLAY_DIR` environment variable | `'custom'` (or `'example'` if it resolves to `example/overlay`) |
| 3 | `<repo>/overlay/` (when `overlay/manifest.json` exists) | `'custom'` |
| 4 | `<repo>/example/overlay/` (automatic fallback, Decision 13) | `'example'` |

Example using `OVERLAY_DIR`:

```bash
OVERLAY_DIR=../my-private-overlay npm run build
```

---

## 3. Overlay Layout

```text
overlay/                              # (or example/overlay/)
├── manifest.json                     # Schema v1 declarative configuration
└── prompts/
    ├── ru/
    │   ├── identity.md
    │   ├── mission.md
    │   ├── principles.md
    │   └── classifier.md
    ├── en/
    │   ├── identity.md
    │   ├── mission.md
    │   ├── principles.md
    │   └── classifier.md
    ├── sr/                           # Serbian Latin (č, ć, đ, š, ž)
    │   └── ...
    └── ja/                           # Polite Japanese (です/ます)
        └── ...
```

---

## 4. `manifest.json` Schema (v1)

The compiler validates `schemaVersion === 1`, `brand.assistantName`, `features`, and `prompts.locales.{ru,en,sr,ja}.{identity,mission,principles,classifier}`.

```jsonc
{
  "schemaVersion": 1,
  "id": "tokio-example",
  "defaultLocale": "ru",
  "brand": {
    "assistantName": "Tokio",
    "localizedNames": { "ru": "Tokio", "en": "Tokio", "sr": "Tokio", "ja": "Tokio" },
    "backupPrefix": "tokio-backup",
    "supportContact": "",
    "miniAppUrl": "",
    "accessDeniedMessage": {
      "ru": "⛔ Доступ закрыт (приватный инстанс).",
      "en": "⛔ Access denied (private instance).",
      "sr": "⛔ Pristup odbijen (privatna instanca).",
      "ja": "⛔ アクセスが拒否されました（プライベートインスタンス）。"
    }
  },
  "defaults": {
    "timezone": "UTC",
    "baseCurrency": "EUR",
    "summaryTime": "07:00",
    "supportedCurrencies": ["EUR", "USD", "GBP", "RUB", "RSD", "JPY", "UAH", "KZT", "TRY", "GEL"],
    "inboxCurrencies": ["EUR", "USD", "RUB", "RSD", "JPY"]
  },
  "features": {
    "spendLimitEnabled": true,
    "spendLimitUsd": 2,
    "onboardingWizard": true,
    "byokCommand": true,
    "feedbackEnabled": true,
    "overloadShield": true,
    "microFocusTriage": true,
    "calmModeUi": true,
    "publicOpenAccess": false
  },
  "finance": {
    "accountAliases": [
      { "account": "Наличные", "patterns": ["cash", "кэш", "налич", "gotovina", "現金"] }
    ],
    "defaultAccountByCurrency": { "EUR": "Наличные", "USD": "Карта" },
    "genericCardAccountByCurrency": { "EUR": "Карта", "USD": "Карта" },
    "reserveAmount": 0
  },
  "miniapp": {
    "tabs": ["today", "tasks", "finances", "notes", "system"],
    "accountThemes": [
      { "pattern": "карт|card|kartic|カード", "theme": "primary" }
    ]
  },
  "prompts": {
    "locales": {
      "ru": {
        "identity": "prompts/ru/identity.md",
        "mission": "prompts/ru/mission.md",
        "principles": "prompts/ru/principles.md",
        "classifier": "prompts/ru/classifier.md"
      }
    },
    "personaStyles": {
      "mentor": { "ru": "...", "en": "...", "sr": "...", "ja": "..." },
      "strategist": { "ru": "...", "en": "...", "sr": "...", "ja": "..." },
      "calm_partner": { "ru": "...", "en": "...", "sr": "...", "ja": "..." },
      "concise": { "ru": "...", "en": "...", "sr": "...", "ja": "..." }
    }
  }
}
```

### Prompt Template Variables

Prompt Markdown files support `{{var}}` interpolation via `getOverlayPrompt(locale, section, vars)`:

- `{{assistantName}}` — automatically populated from `getAssistantName(locale)`.
- `{{currencies}}` — passed by the inbox classifier from `manifest.defaults.inboxCurrencies`.

---

## 5. Feature Flags (Replacing `[public-only]` / `[edition-specific]`)

Previously, edition differences were maintained via inline `[public-only]` and `[edition-specific]` code forks. All behavioral toggles are now driven declaratively from `manifest.features`:

| Feature Flag | Type | Replaces / Controls |
| :--- | :--- | :--- |
| `spendLimitEnabled` | `boolean` | Enables per-user shared-key LLM USD budget cap (`[public-only]`). |
| `spendLimitUsd` | `number` | Monthly/total USD cap when `spendLimitEnabled` is `true`. |
| `onboardingWizard` | `boolean` | Multi-step first-run onboarding wizard (`[public-only]`). |
| `byokCommand` | `boolean` | `/key` BYOK command allowing users to attach their own Gemini API key. |
| `feedbackEnabled` | `boolean` | `/feedback` reporting flow (`[public-only]`). |
| `overloadShield` | `boolean` | Dynamic cognitive overload shield appended to system prompt tail. |
| `microFocusTriage` | `boolean` | 1+3 daily micro-focus triage helpers. |
| `calmModeUi` | `boolean` | Low-stimulation (Calm) mode toggle in the Mini App and prompt. |
| `publicOpenAccess` | `boolean` (optional) | Explicit open registration for a public instance: `true` lets `checkAccess` admit users outside `ADMIN_IDS` / `BETA_WHITELIST` / `users`. |

### 5.1 `publicOpenAccess` — open registration without weakening fail-closed

`checkAccess` (`src/lib/auth.ts`) is the only access gate. Its default stays fail-closed:
an empty access list in production replies `ACCESS_UNCONFIGURED_*`, and a non-empty list
rejects unknown users. `publicOpenAccess` is the single, explicit way to open it:

- **Only the overlay can set it.** There is no env variable and no config key; the value
  comes from `overlay/manifest.json` (or `OVERLAY_DIR`) at build time.
- **Only a literal `true` opens anything.** The field is optional, so an overlay that never
  declares it (the personal one) reads `undefined`, which the gate treats as `false`. Adding
  this key therefore does not require editing an existing personal overlay and cannot flip it
  open by accident.
- **It short-circuits the whole tree,** including the production "access list is not
  configured" branch. That is deliberate: a public instance may legitimately run with an
  empty `ADMIN_IDS`, and the flag is the statement of intent that makes it safe.
- **Use it only for a deliberately public bot.** A private/personal instance should omit the
  key or set it to `false`, and keep `ADMIN_IDS` populated so the fail-closed gate stays armed.

---

## 6. Runtime API (`src/lib/overlay.ts`)

`src/lib/overlay.ts` is the sole runtime entry point for overlay data and has **zero** runtime imports from `./i18n.js` or `node:fs`:

- `getOverlay(): CompiledOverlay` — returns active manifest + compiled prompts (with any test override deep-merged).
- `getOverlaySource(): 'custom' | 'example'` — indicates whether the build used a custom overlay or the `example/overlay/` fallback.
- `setOverlayOverride(patch: OverlayOverride | null): void` / `resetOverlayOverride(): void` — in-memory deep-merge overrides for deterministic unit tests.
- `getAssistantName(locale?: OverlayLocaleCode): string` — returns localized or default assistant name.
- `getOverlayPrompt(locale, section, vars?): string` — returns interpolated prompt Markdown.
- `getPersonaStyleText(style, locale?): string | null` — resolves a persona style key (`mentor`, `strategist`, `calm_partner`, `concise`) or returns `null` for free-text styles.
- `getDemoSeed(locale?: OverlayLocaleCode): DemoSeedLocale` — returns localized demo seed data compiled from `example/seed/demo.json`.

---

## 7. Build Integration & Module Budget

- `pretypecheck` and `pretest` run `node scripts/ensure-secrets-stub.mjs && node scripts/compile-runtime-assets.mjs`.
- `build.mjs` invokes `compileRuntimeAssets()` at startup, logs `overlay source: <custom|example>`, excludes `src/lib/overlay.ts`, `src/lib/overlay.generated.ts`, `src/lib/i18n.ts`, and `src/lib/i18n.generated.ts` from the unbundled pass, and bundles:
  - `src/lib/overlay.ts` → `tgcloud/lib/overlay.js` (1 module)
  - `src/lib/i18n.ts` → `tgcloud/lib/i18n.js` (1 module)
- Total emitted `.js` modules in `tgcloud/` remain strictly bounded by `MODULE_CAP = 100`.

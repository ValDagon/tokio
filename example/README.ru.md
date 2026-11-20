# Пример оверлея и демо-данных Tokio

В этой папке находятся встроенный **резервный оверлей** (`example/overlay/`) и **локализованный демо-набор** (`example/seed/demo.json`) для Tokio.

## Автоматический fallback

Если файл `<repo>/overlay/manifest.json` отсутствует, скрипт `scripts/compile-runtime-assets.mjs` автоматически компилирует `example/overlay/` в `src/lib/overlay.generated.ts`. Благодаря этому проверка типов, тесты и сборка работают сразу после клонирования репозитория без ручной настройки.

## Как создать свой оверлей

1. Скопируйте пример в игнорируемую git папку `overlay/`:

   ```bash
   cp -R example/overlay overlay
   ```

   Либо храните оверлей в отдельной директории и передавайте путь через переменную окружения `OVERLAY_DIR`:

   ```bash
   OVERLAY_DIR=/path/to/my-overlay npm run build
   ```

2. Отредактируйте `overlay/manifest.json`:
   - `brand`: задайте `assistantName`, `localizedNames`, `backupPrefix`, `supportContact`, `miniAppUrl` и `accessDeniedMessage`.
   - `defaults`: настройте `timezone`, `baseCurrency`, `summaryTime`, `supportedCurrencies` и `inboxCurrencies`.
   - `features`: включите или отключите флаги возможностей (`spendLimitEnabled`, `spendLimitUsd`, `onboardingWizard`, `byokCommand`, `feedbackEnabled`, `overloadShield`, `microFocusTriage`, `calmModeUi`).
   - `finance`: укажите `accountAliases`, `defaultAccountByCurrency`, `genericCardAccountByCurrency` и `reserveAmount`.
   - `miniapp`: настройте `tabs` и `accountThemes`.
   - `prompts.personaStyles`: отредактируйте описания стилей общения (`mentor`, `strategist`, `calm_partner`, `concise`).

3. При необходимости измените Markdown-промпты в `overlay/prompts/{ru,en,sr,ja}/{identity,mission,principles,classifier}.md`:
   - Используйте `{{assistantName}}` для подстановки имени ассистента.
   - В `classifier.md` сохраните JSON-схему и плейсхолдер `{{currencies}}`.

## Демо-набор (`example/seed/demo.json`)

Файл `example/seed/demo.json` содержит нейтральный стартовый набор (3 счёта, 1 ежемесячное обязательство, 3 задачи и 3 заметки для поиска) на языках `ru`, `en`, `sr` и `ja`. Он компилируется в бандл оверлея и доступен через `getDemoSeed(locale)` для онбординга и демо-режима.

## Локальная проверка и деплой

Проверьте проект локально:

```bash
npm run typecheck && npm test && npm run build
```

Задеплойте в Telegram Serverless (`tgcloud.ai`):

```bash
npx tgcloud push && npx tgcloud migrate --yes
```

Подробная спецификация: [docs/system/OVERLAY-SPEC.md](../docs/system/OVERLAY-SPEC.md).

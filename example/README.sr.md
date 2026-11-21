# Primer overlay konfiguracije i demo podataka za Tokio

Ovaj direktorijum sadrži ugrađeni **rezervni overlay** (`example/overlay/`) i **lokalizovani demo skup podataka** (`example/seed/demo.json`) za Tokio.

## Automatski fallback

Ako fajl `<repo>/overlay/manifest.json` ne postoji, skripta `scripts/compile-runtime-assets.mjs` automatski kompajlira `example/overlay/` u `src/lib/overlay.generated.ts`. Zbog toga provera tipova, testovi i build rade odmah nakon kloniranja repozitorijuma bez dodatnog podešavanja.

## Kreiranje sopstvenog overlay-a

1. Kopirajte primer u `overlay/` direktorijum (koji je u `.gitignore`):

   ```bash
   cp -R example/overlay overlay
   ```

   Alternativno, čuvajte overlay van repozitorijuma i prosledite putanju kroz promenljivu okruženja `OVERLAY_DIR`:

   ```bash
   OVERLAY_DIR=/path/to/my-overlay npm run build
   ```

2. Izmenite `overlay/manifest.json`:
   - `brand`: podesite `assistantName`, `localizedNames`, `backupPrefix`, `supportContact`, `miniAppUrl` i `accessDeniedMessage`.
   - `defaults`: podesite `timezone`, `baseCurrency`, `summaryTime`, `supportedCurrencies` i `inboxCurrencies`.
   - `features`: uključite ili isključite feature flag-ove (`spendLimitEnabled`, `spendLimitUsd`, `onboardingWizard`, `byokCommand`, `feedbackEnabled`, `overloadShield`, `microFocusTriage`, `calmModeUi`, `publicOpenAccess`).
   - `finance`: definišite `accountAliases`, `defaultAccountByCurrency`, `genericCardAccountByCurrency` i `reserveAmount`.
   - `miniapp`: prilagodite `tabs` i `accountThemes`.
   - `prompts.personaStyles`: prilagodite stilove komunikacije (`mentor`, `strategist`, `calm_partner`, `concise`).

3. Po želji izmenite Markdown promptove u `overlay/prompts/{ru,en,sr,ja}/{identity,mission,principles,classifier}.md`:
   - Koristite `{{assistantName}}` za ime asistenta.
   - U `classifier.md` sačuvajte JSON šemu i promenljivu `{{currencies}}`.

## Demo podaci (`example/seed/demo.json`)

Fajl `example/seed/demo.json` sadrži neutralan početni skup podataka (3 računa, 1 mesečnu obavezu, 3 zadatka i 3 beleške za pretragu) za jezike `ru`, `en`, `sr` i `ja`. Kompajlira se u overlay paket i dostupan je preko `getDemoSeed(locale)` za onboarding i demo okruženje.

## Lokalna provera i deployment

Pokrenite lokalnu proveru:

```bash
npm run typecheck && npm test && npm run build
```

Objavite na Telegram Serverless (`tgcloud.ai`):

```bash
npx tgcloud push && npx tgcloud migrate --yes
```

Detaljna specifikacija: [docs/system/OVERLAY-SPEC.md](../docs/system/OVERLAY-SPEC.md).

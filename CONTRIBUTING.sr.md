[English](CONTRIBUTING.md) | [Русский](CONTRIBUTING.ru.md) | **Srpski** | [日本語](CONTRIBUTING.ja.md)

# Doprinos razvoju projekta Tokio

Hvala na interesovanju za doprinos projektu **Tokio**! Pre slanja Pull Request-a pročitajte [`AGENTS.md`](AGENTS.md) i ovo uputstvo.

---

## 1. Granica između Core i Overlay sloja

Tokio je organizovan kao otvoreno jezgro za višekratnu upotrebu uz privatne deklarativne overlay pakete:

- **Pripada Core sloju (`src/`, `miniapp/src/`, `locales/`, `tests/`)**: neutralni mehanizmi — alati agenta, interfejsi, SQLite šema i DAL, ispravke grešaka, testovi, tačke proširenja i deklarativni feature flag-ovi.
- **Pripada Overlay sloju (`overlay/` ili `OVERLAY_DIR`)**: lični izbor konkretne instance — brendiranje, lični promptovi, ton komunikacije, stil savetovanja, nazivi ličnih banaka i lični podaci.
- **Sporno ponašanje**: stavite iza feature flag-a u `manifest.features` ([`docs/system/OVERLAY-SPEC.md`](docs/system/OVERLAY-SPEC.md)).

Nikada nemojte slati lične promptove, stvarne Telegram korisničke ID-jeve, privatne adrese e-pošte, URL-ove vaših deployment-a ili nazive ličnih računa u PR-ovima.

---

## 2. Podešavanje lokalnog okruženja

Potrebni su **Node.js 22+** i `npm`:

```bash
git clone https://github.com/ValDagon/tokio.git
cd tokio
npm install
(cd miniapp && npm install)
```

- `npm install` automatski podešava `git config core.hooksPath .githooks`, aktivirajući `.githooks/pre-push` proveru.
- Opciono: instalirajte `gitleaks` (`brew install gitleaks`) za lokalno skeniranje tajni pre svakog push-a.

---

## 3. Obavezne provere pre slanja PR-a

Svaki Pull Request mora proći sve lokalne provere sa `exit code 0`:

```bash
# 1. Provera curenja podataka i higijena
npm run check:leaks

# 2. Backend / V8 izolat
npm run typecheck
npm test
npm run build        # proverava ograničenje <= 100 modula i graf zavisnosti

# 3. Mini App
cd miniapp
npm run lint
npm test
npm run build
```

---

## 4. Politika lokalizacije (4 jezika)

Tokio podržava **4 jezika**: `en` (engleski), `ru` (ruski), `sr` (srpski, latinica sa dijakriticima `č, ć, đ, š, ž`) i `ja` (učtivi japanski `です/ます`).

- Kada dodajete ili menjate tekstove za korisnike, ažurirajte sva 4 fajla u `locales/{en,ru,sr,ja}.json` i/ili `miniapp/src/i18n/locales/{en,ru,sr,ja}.json`.
- Testovi potpunosti prevoda proveravaju podudaranje ključeva na sva 4 jezika.

---

## 5. Smernice za Pull Request

- Koristite [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Neka PR bude fokusiran i propraćen testovima za nove funkcionalnosti ili ispravke grešaka.
- Popunite kontrolnu listu iz [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) i proverite da CI (`backend`, `miniapp` i `security-leaks`) prolazi bez grešaka.
- Slanjem doprinosa potvrđujete da se vaš kod objavljuje pod licencom [Apache License, Version 2.0](LICENSE) (pogledajte i [`NOTICE`](NOTICE) i [`CONTRIBUTORS.md`](CONTRIBUTORS.md)).

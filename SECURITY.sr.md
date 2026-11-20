[English](SECURITY.md) | [Русский](SECURITY.ru.md) | **Srpski** | [日本語](SECURITY.ja.md)

# Politika bezbednosti

## Podržane verzije

| Verzija | Podržana |
| :--- | :--- |
| `3.x` | :white_check_mark: |
| `< 3.0` | :x: |

---

## Prijavljivanje ranjivosti

Bezbednost projekta **Tokio** shvatamo ozbiljno. Ako otkrijete bezbednosni propust, **nemojte** ga objavljivati u javnim GitHub Issues, Pull Request-ovima ili diskusijama.

### Procedura privatnog prijavljivanja

1. Otvorite **Private Vulnerability Report** putem [GitHub Security Advisories](https://github.com/ValDagon/tokio/security/advisories).
2. Navedite dovoljno detalja za reprodukciju i procenu:
   - Tip problema (curenje tajni, zaobilaženje autentifikacije, IDOR / probijanje izolacije korisnika, prompt injection, XSS, SQL injekcija itd.).
   - Pogođenu komponentu (`src/handlers/`, `src/endpoints/rpc.ts`, `src/lib/dal/`, `miniapp/`, `scripts/` ili alate za build).
   - Minimalne korake za reprodukciju ili Proof-of-Concept (PoC).
   - Potencijalni uticaj u slučaju zloupotrebe.

### Rokovi odgovora

- **Početna potvrda prijema**: u roku od 48 sati.
- **Trijaža i procena**: u roku od 5 radnih dana.
- **Ispravka i objava**: zakrpa se priprema privatno i objavljuje na `main`, uz navođenje zasluga istraživaču osim ako ne zatraži anonimnost.

---

## Osnove bezbednosne arhitekture

- **BYOK enkripcija u mirovanju (`src/lib/crypto.ts`)**: Korisnički Gemini API ključevi šifruju se pure-TypeScript implementacijom RFC 8439 ChaCha20-Poly1305 uz jedinstveni 96-bitni nonce i HMAC-SHA256 verifikaciju.
- **Autentifikacija Mini App-a (`src/endpoints/rpc.ts`, `src/lib/auth.ts`)**: Produkcijski RPC zahtevi verifikuju Telegram WebApp `initData` potpis (`HMAC-SHA256`) i vremensku ispravnost polja `auth_date`.
- **Izolacija korisnika (`src/lib/dal/`)**: Svako čitanje i upis u DAL sloju obavezno filtrira po `user_id` / `telegram_id`, uz podršku za otvorenu registraciju ili fail-closed belu listu (`ADMIN_IDS`, `BETA_WHITELIST`).
- **Troslojna zaštita od curenja**: Privatni `overlay/`, fajlovi sa tajnama i `.forbidden-strings.local` isključeni su kroz `.gitignore`, proveravaju se lokalno putem `.githooks/pre-push` (`scripts/check-leaks.mjs` + `gitleaks`) i obavezni su u GitHub Actions CI-ju.

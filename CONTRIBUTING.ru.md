[English](CONTRIBUTING.md) | **Русский** | [Srpski](CONTRIBUTING.sr.md) | [日本語](CONTRIBUTING.ja.md)

# Участие в разработке Tokio

Спасибо за интерес к развитию **Tokio**! Перед отправкой Pull Request обязательно ознакомьтесь с [`AGENTS.md`](AGENTS.md) и этим руководством.

---

## 1. Граница между Core и Overlay

Tokio разделяет переиспользуемое открытое ядро и приватные декларативные оверлеи:

- **Место в Core (`src/`, `miniapp/src/`, `locales/`, `tests/`)**: нейтральные механизмы — инструменты агента, интерфейсы, схема и DAL SQLite, исправления ошибок, тесты, точки расширения и декларативные флаги.
- **Место в Overlay (`overlay/` или `OVERLAY_DIR`)**: вкусовые настройки конкретного инстанса — бренд, личные промпты, стиль общения, коучинговые установки, названия личных банков и персональные данные.
- **Спорное поведение**: выносите за флаг в `manifest.features` ([`docs/system/OVERLAY-SPEC.md`](docs/system/OVERLAY-SPEC.md)).

Никогда не добавляйте в PR личные промпты, реальные Telegram ID, личные адреса почты, URL ваших деплоев или названия личных счетов.

---

## 2. Локальная настройка окружения

Требуются **Node.js 22+** и `npm`:

```bash
git clone https://github.com/ValDagon/tokio.git
cd tokio
npm install
(cd miniapp && npm install)
```

- `npm install` автоматически настраивает `git config core.hooksPath .githooks`, подключая хук `.githooks/pre-push`.
- Опционально: установите `gitleaks` (`brew install gitleaks`) для локальной проверки секретов перед каждым `git push`.

---

## 3. Обязательные проверки перед PR

Перед отправкой PR все команды должны завершаться с `exit code 0`:

```bash
# 1. Проверка на утечки и гигиена
npm run check:leaks

# 2. Бэкенд / V8-изолят
npm run typecheck
npm test
npm run build        # проверяет лимит <= 100 модулей и целостность графа импортов

# 3. Mini App
cd miniapp
npm run lint
npm test
npm run build
```

---

## 4. Правило локализации (4 языка)

Tokio поддерживает **4 локали**: `en` (английский), `ru` (русский), `sr` (сербский, латиница с диакритикой `č, ć, đ, š, ž`) и `ja` (вежливый японский `です/ます`).

- При добавлении или изменении пользовательских строк обновляйте все 4 файла в `locales/{en,ru,sr,ja}.json` и/или `miniapp/src/i18n/locales/{en,ru,sr,ja}.json`.
- Тесты полноты локалей проверяют равенство наборов ключей во всех четырёх языках.

---

## 5. Правила оформления Pull Request

- Используйте формат [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Делайте PR сфокусированными и покрывайте новые функции и багфиксы тестами.
- Заполняйте чек-лист [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) и проверяйте прохождение всех задач CI (`backend`, `miniapp`, `security-leaks`).
- Отправляя вклад в репозиторий, вы соглашаетесь с условиями лицензии [Apache License, Version 2.0](LICENSE) (см. также [`NOTICE`](NOTICE) и [`CONTRIBUTORS.md`](CONTRIBUTORS.md)).

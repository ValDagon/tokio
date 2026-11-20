# Parity-тесты Python ↔ TS (ADR-004)

Golden-master проверка: одни и те же входные данные прогоняются через
Python-референс (v1 FastAPI, тег `legacy-v1-fastapi`) и через TS-порт, результаты сравниваются
по полям. Python — источник истины; каждое расхождение либо чинится в порте,
либо **явно документируется здесь** и фиксируется отдельным ожиданием в тесте.
Молча подгонять ожидания под TS запрещено.

Область владения — `tests/parity/**`. Тесты не трогают `src/`.

## Где теперь Python-эталон

Сервис выведен из эксплуатации 13.11.2026 и полностью удалён из `HEAD` 18.11.2026;
исторический код v1 и миграции сохранены в git-теге `legacy-v1-fastapi`. Ни бот,
ни Mini App их не исполняют; тесты в `tests/parity/*.parity.test.ts` читают только
готовые `fixtures/*.json`.

Доступ к эталону через git-тег:

| Что нужно | Как |
| --- | --- |
| Прочитать файл по историческому пути | `git show legacy-v1-fastapi:backend/app/services/fx.py` |
| Развернуть во временный worktree | `git worktree add /tmp/legacy-v1 legacy-v1-fastapi` |
| Перегенерировать фикстуры | команды ниже — через `LEGACY_BACKEND_DIR` |

Шапки модулей `src/**` могут упоминать `backend/app/…`:
это исторический провенанс порта, читайте файл по тегу `legacy-v1-fastapi`.

## Что покрыто

| Область | Python-референс | TS-реализация | Кейсов | Статус |
| --- | --- | --- | --- | --- |
| Деньги: округление | `round(x, 2)` и `convert_to_eur` (`app/services/fx.py`) | `toCents()` (`src/lib/utils.ts`) | 28 | 21 паритет, 7 расхождений (округление .5) |
| Деньги: конвертация | `convert_to_eur` | `convert()` (`src/lib/dal/fx.ts`) | 14 | 11 паритет, 3 расхождения (граница float→cents) |
| Даты/таймзоны | `zoneinfo` + `astimezone` + `strftime` | `zonedParts`/`dateKey`/`monthKey`/`timeKey`/`formatDate`/`formatDateTime` (`src/lib/utils.ts`) | 22 | полный паритет |
| Прибавление дней | aware `datetime + timedelta(days=n)` | `addDays()` (`src/lib/utils.ts`) | 10 | 6 паритет, 4 расхождения (DST) |
| Повторы | `calculate_next_occurrence` (`app/services/tasks.py`) | `nextOccurrence()` (`src/lib/dal/tasks.ts`) | 23 | полный паритет |
| Runway | `calculate_runway` (`app/services/runway.py`) | `calculateRunway()` (`src/lib/runway.ts`) | 25 | 22 паритет, 3 расхождения |

Файлы:

```
tests/parity/
  generate.py            # генератор фикстур (Python-референс)
  fixtures/*.json        # golden-master выходы Python
  loader.ts              # чтение и типы фикстур
  money.parity.test.ts
  dates.parity.test.ts
  recurrence.parity.test.ts
  runway.parity.test.ts
```

## Как регенерировать фикстуры

`uv` ставится в `~/.local/bin` и не всегда в PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
git worktree add /tmp/legacy-v1 legacy-v1-fastapi
LEGACY_BACKEND_DIR=/tmp/legacy-v1/backend uv run --project /tmp/legacy-v1/backend --python 3.12 --no-sync python tests/parity/generate.py
git worktree remove /tmp/legacy-v1
```

`--no-sync` **обязателен**: без него uv пытается пересобрать `ormsgpack`
и падает. Системный `python3` (3.11) не подходит — backend требует ≥ 3.12.

Генератор детерминирован: `NOW` зафиксирован как `2026-11-06T10:00:00+00:00`,
нет `Date.now()`, `random`, сети. Повторный запуск обязан давать байт-в-байт
те же файлы. Проверка:

```bash
md5sum tests/parity/fixtures/*.json > /tmp/parity.md5
# …перегенерация…
md5sum -c /tmp/parity.md5
```

## Запуск тестов

```bash
npx vitest run tests/parity/
npm run typecheck
```

## Задокументированные расхождения

### 1. Округление на границе .5 (деньги)

Python `round()` — банковское округление (half-to-even), TS `toCents()` —
арифметическое half-up после `toPrecision(15)`. Это осознанный выбор порта:
деньги не должны «терять» цент на половине (ADR-003).

| Кейс | Значение | Python | TS |
| --- | --- | --- | --- |
| `round2-2.675` | 2.675 | 267 | 268 |
| `round2-1.005` | 1.005 | 100 | 101 |
| `round2-0.125` | 0.125 | 12 | 13 |
| `round2-0.015` | 0.015 | 1 | 2 |
| `round2-5.555` | 5.555 | 555 | 556 |
| `round2-1.115` | 1.115 | 111 | 112 |
| `round2--12.345` | −12.345 | −1235 | −1234 |

Последний случай — особенность `Math.round`: `Math.round(-1234.5) = -1234`
(округление к +∞), тогда как Python даёт `-12.35`.

### 2. Конвертация валют (граница float→cents)

Вход в TS идёт через `toCents(amount)`, в Python — через `round(amount / rate, 2)`.
Разница возникает на стыке двух округлений.

| Кейс | Python | TS | Причина |
| --- | --- | --- | --- |
| `convert-0-USD-10.005` | 926 | 927 | py: `round(9.263…, 2) = 9.26`; ts: `toCents(10.005) = 1001`, `round(1001/1.08) = 927` |
| `convert-2-USD-0.005` | 0 | 1 | py: `round(0.0046…, 2) = 0.0`; ts: `toCents(0.005) = 1` |
| `convert-13-EUR--7.775` | −778 | −777 | py: `round(-7.775, 2) = -7.78`; ts: `toCents(-7.775) = Math.round(-777.5) = -777` |

### 3. `addDays()` на переходе DST

TS прибавляет ровно `n * 86 400 000` мс (астрономические сутки). Python
прибавляет `timedelta(days=n)` к aware-дате, то есть сохраняет настенное время.
На переходе DST это даёт час разницы. Все 4 расхождения — `Europe/Berlin`,
UTC и New York совпадают.

| Кейс | Дни | Python (UTC) | TS (UTC) |
| --- | --- | --- | --- |
| `add-days-3` | +1 (25.10, на зиму) | 13:00 | 12:00 |
| `add-days-4` | +7 (31.10) | 13:00 | 12:00 |
| `add-days-5` | +1 (29.03, на лето) | 11:00 | 12:00 |
| `add-days-6` | +2 (30.03) | 11:00 | 12:00 |

### 4. Runway

| Кейс | Поле | Python | TS | Причина |
| --- | --- | --- | --- | --- |
| `liability-payment-day-null` | `reservedCents` | 0 | 5 000 | Python пропускает обязательства без `payment_day` (`if not payment_day: continue`), TS резервирует по `accountId` |
| `liability-payment-day-null` | `spendableCents` / `safe*` / `runwayDays` | 30 000 / 15 дней | 25 000 / 12 дней | следствие резерва выше |
| `liability-payment-day-null` | `cashReserveCents` | 42 000 | 5 000 | Python не видит платёж → fallback 420 €; TS резервирует 5 000 |
| `unattached-eur-rent` | `reservedCents` | 30 000 | 0 | Python резервирует незакреплённый платёж по критерию очереди (`queue_1` → Cash); TS резервирует только по `accountId` |
| `unattached-eur-rent` | `spendableCents` / `safe*` / `runwayDays` | 90 000 / 45 дней | 120 000 / 60 дней | следствие выше |
| `overdue-payment-day` | `pendingHorizonCents` | 80 000 | 40 000 | Python включает просроченный платёж (день 1 < сегодня) в горизонт, TS — только даты в `[сегодня, конец горизонта]` |
| `overdue-payment-day` | `reservedGapCents` | −40 000 | 0 | следствие выше |

### 5. `cashReserveCents`: фиктивный резерв 420 € в Python

Если у пользователя нет ни одного «наличного» обязательства, Python
подставляет `cash_reserve_eur = 420.0` (жёстко зашитый резерв на аренду/налоги,
`backend/app/services/runway.py:125`). TS в этом случае возвращает 0.

- 13 кейсов без cash-обязательств: Python 42 000, TS 0 (список в
  `runway.parity.test.ts`, группа `FALLBACK`);
- 10 кейсов с прикреплённым cash-обязательством — значения совпадают
  (группа `ATTACHED`);
- 2 особых случая — `liability-payment-day-null` и `unattached-eur-rent`
  (см. таблицу выше).

## Что намеренно вне паритета

| Что | Почему |
| --- | --- |
| `parse_datetime_ru`, `parse_recurrence`, `format_recurrence_ru` | В TS-порте нет текстовых парсеров: даты и повторы разбирает LLM-классификатор, форматирование — через `Intl`. Сравнивать нечего. |
| `parseAmountToCents`, `formatCents`, `formatMoney` | В Python-бэкенде нет прямых аналогов (там float + `round`), сравнивать пришлось бы разные сущности. Покрыты своими unit-тестами (`tests/utils.test.ts`). |
| `weekdays` у weekly-правила | В Python такого поля нет — это TS-расширение. |
| `count` у правила | Обрабатывается в `completeTask`/`complete_task_with_recurrence`, а не в `nextOccurrence`. |
| Прожигание по транзакциям | Python считает окно в локальной TZ (`now.astimezone()`), результат зависит от машины. Во всех кейсах передаётся `daily_burn_override`. |
| `runwayWeeks` (Python) vs `runwayMonths` (TS) | Разные единицы и разная семантика округления — сравнивать нечего. |
| `daysRemainingInMonth` | В TS-результате поля нет. |
| `accountEnvelopes` | Python классифицирует по имени счёта (`classify_envelope`) и умеет «mixed (rent+taxes + spendable)»; TS хранит `envelope` в самом счёте. Совпадают только чистые `spendable`/`reserved`-счета, поэтому поле не сравнивается. |
| Порядок `upcoming` при равных днях | Python сортирует по `(payment_day is None, payment_day)`, TS добавляет `localeCompare('ru')`. Состав сравнивается как множество `name@day`. |

## Правила при изменениях

1. Меняешь Python-референс — перегенерируй фикстуры и посмотри, какие тесты
   упали; расхождение сначала объясни, потом чини порт или документируй здесь.
2. Меняешь TS-порт — фикстуры НЕ трогай: падение parity-теста и есть сигнал.
3. Новое расхождение → строчка в таблицах выше + явный `EXPECTED`-map в тесте
   + guard-тест на состав расхождений.

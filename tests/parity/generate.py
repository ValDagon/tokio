#!/usr/bin/env python3
"""Golden-master генератор parity-фикстур (ADR-004, SPEC §3, T-parity).

Python-бэкенд — референс. Он выведен из эксплуатации 13.11.2026 и удалён из
`HEAD` 18.11.2026; исторический код сохранён в git-теге `legacy-v1-fastapi`
(`git show legacy-v1-fastapi:backend/…`). Скрипт гоняет ОДНИ И ТЕ ЖЕ входы через
Python-функции и складывает результаты в `tests/parity/fixtures/*.json`.
TS-порт проверяется тестами `tests/parity/*.parity.test.ts`: они читают эти
JSON-ы и сравнивают со своими значениями.

Запуск при необходимости пересборки (из тега `legacy-v1-fastapi`):

    git worktree add /tmp/legacy-v1 legacy-v1-fastapi
    LEGACY_BACKEND_DIR=/tmp/legacy-v1/backend uv run --project /tmp/legacy-v1/backend --no-sync python tests/parity/generate.py

Скрипт детерминирован: фиксированный `NOW`, никаких Date.now/random/сети.
Повторный запуск обязан давать байт-в-байт те же файлы.

Что НЕ покрыто намеренно (см. README.md рядом):
  - `parse_datetime_ru` / `parse_recurrence` / `format_recurrence_ru` — в TS-порте
    нет текстового парсера (даты/повторы разбирает LLM-классификатор);
  - прожигание по транзакциям — в Python зависит от локальной TZ
    (`now.astimezone()`), поэтому во всех кейсах передаётся `daily_burn_override`;
  - `weekdays` у weekly-правила — в Python такого поля нет.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
BACKEND = Path(os.environ.get("LEGACY_BACKEND_DIR", "/tmp/legacy-v1/backend"))
if not BACKEND.exists():
    raise SystemExit(
        f"Python parity reference not found at {BACKEND}. "
        "Checkout tag `legacy-v1-fastapi` first: `git worktree add /tmp/legacy-v1 legacy-v1-fastapi`"
    )
sys.path.insert(0, str(BACKEND))

from app.services import fx as fx_service  # noqa: E402
from app.services import runway as runway_service  # noqa: E402
from app.services import tasks as tasks_service  # noqa: E402
from app.services.runway import calculate_runway  # noqa: E402
from app.services.tasks import calculate_next_occurrence  # noqa: E402

FIXTURES = HERE / "fixtures"

# Единственный «сейчас» во всём наборе: 2026-11-06 10:00 UTC.
NOW_ISO = "2026-11-06T10:00:00+00:00"
NOW = datetime.fromisoformat(NOW_ISO)

# Курсы-фолбэк Python (`app.services.fx.FALLBACK_RATES`): единиц валюты за 1 EUR.
RATES = dict(fx_service.FALLBACK_RATES)


# ---------------------------------------------------------------------------
# Инфраструктура: фиксированный `now`, заглушки БД/fx
# ---------------------------------------------------------------------------


class FixedDatetime(datetime):
    """`datetime` с подменённым `now()` — иначе генератор невоспроизводим."""

    @classmethod
    def now(cls, tz=None):  # type: ignore[override]
        if tz is None:
            return NOW.replace(tzinfo=None)
        return NOW.astimezone(tz)


class _FakeAcquire:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *_exc):
        return False


class _FakePool:
    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        return _FakeAcquire(self._conn)


class FakeConn:
    """Отдаёт заранее заданные строки вместо Postgres; строки — обычные dict."""

    def __init__(self, accounts, liabilities):
        self._accounts = accounts
        self._liabilities = liabilities
        self.queries: list[str] = []

    async def fetch(self, query, *_args):
        self.queries.append(query)
        if "FROM ag.accounts" in query:
            return list(self._accounts)
        if "FROM ag.liabilities" in query:
            return list(self._liabilities)
        raise AssertionError(f"unexpected fetch: {query[:80]}")

    async def fetchrow(self, query, *_args):
        self.queries.append(query)
        raise AssertionError(f"unexpected fetchrow (fixtures always pass daily_burn_override): {query[:80]}")

    async def execute(self, query, *_args):
        self.queries.append(query)
        return "OK"


async def _fake_rates(base: str = "EUR"):
    """`get_exchange_rates` без сети и без кеша в БД."""
    if base.upper() != "EUR":
        raise AssertionError(f"unexpected fx base {base}")
    return dict(RATES)


async def _no_ensure_accounts(_conn, _telegram_id):
    """`ensure_accounts_and_categories` — в фикстурах счета заданы явно."""
    return None


def install_stubs() -> None:
    """Глобальные заглушки: время, курсы, БД. Один раз на процесс."""
    tasks_service.datetime = FixedDatetime
    fx_service.get_exchange_rates = _fake_rates
    runway_service.ensure_accounts_and_categories = _no_ensure_accounts


def fixed_now_date() -> date:
    return NOW.date()


def cents(amount_eur: float) -> int:
    """EUR-float → целые центы (одно округление, как в ADR-003)."""
    return int(round(amount_eur * 100))


# ---------------------------------------------------------------------------
# 1. Деньги
# ---------------------------------------------------------------------------

# Значения на границах: двоичные «полуценты», banker's rounding Python,
# отрицательные, ноль, очень малые и очень большие суммы.
ROUND_INPUTS = [
    0,
    -0.0,
    2.675,
    1.005,
    0.125,
    0.135,
    2.5,
    0.005,
    0.015,
    1.004999,
    1234.565,
    12.345,
    12.335,
    8.845,
    5.555,
    0.999,
    1.115,
    4.35,
    -2.675,
    -1.005,
    -0.125,
    -12.345,
    0.1 + 0.2,
    1e-7,
    99_999_999.995,
    1_000_000.005,
    0.335,
    0.665,
]

# Суммы для конвертации в EUR по FALLBACK_RATES.
CONVERT_INPUTS = [
    ("USD", 10.005),
    ("USD", 1234.56),
    ("USD", 0.005),
    ("USD", 2.675),
    ("USDT", 100.01),
    ("USDC", 0.01),
    ("RUB", 98765.43),
    ("RUB", 0.5),
    ("KZT", 500000.55),
    ("TRY", 1234.56),
    ("BAM", 99.99),
    ("BAM", 1.95583),
    ("EUR", 12.345),
    ("EUR", -7.775),
]


async def build_money() -> dict:
    round_cases = []
    for value in ROUND_INPUTS:
        rounded = round(float(value), 2)
        round_cases.append(
            {
                "id": f"round2-{value!r}",
                "amount": value,
                "pythonRound2": rounded,
                "pythonRound2Cents": cents(rounded),
            }
        )

    convert_cases = []
    for index, (currency, amount) in enumerate(CONVERT_INPUTS):
        py_eur = await fx_service.convert_to_eur(amount, currency)
        convert_cases.append(
            {
                "id": f"convert-{index}-{currency}-{amount}",
                "currency": currency,
                "amount": amount,
                "amountCents": cents(amount),
                "pythonEur": py_eur,
                "pythonEurCents": cents(py_eur),
            }
        )

    return {
        "generatedBy": "tests/parity/generate.py",
        "reference": "backend/app/services/fx.py (convert_to_eur), Python round(x, 2)",
        "now": NOW_ISO,
        "rates": RATES,
        "roundCases": round_cases,
        "convertCases": convert_cases,
    }


# ---------------------------------------------------------------------------
# 2. Даты и таймзоны
# ---------------------------------------------------------------------------

# instants + tz — референс `zoneinfo` (astimezone + strftime).
DATE_CASES = [
    ("2026-11-06T10:00:00+00:00", "UTC"),
    ("2026-11-06T23:30:00+00:00", "UTC"),
    ("2026-11-06T23:30:00+00:00", "Europe/Berlin"),
    ("2026-11-06T00:30:00+00:00", "Europe/Berlin"),
    ("2026-01-01T00:00:00+00:00", "Europe/Berlin"),
    ("2025-12-31T23:59:59+00:00", "Europe/Berlin"),
    ("2026-03-29T00:30:00+00:00", "Europe/Berlin"),  # за час до перехода на летнее
    ("2026-03-29T01:30:00+00:00", "Europe/Berlin"),  # 03:30 CEST — переход
    ("2026-10-25T00:30:00+00:00", "Europe/Berlin"),  # 02:30 CEST
    ("2026-10-25T01:30:00+00:00", "Europe/Berlin"),  # 02:30 CET — переход
    ("2026-03-08T07:30:00+00:00", "America/New_York"),
    ("2026-11-01T05:30:00+00:00", "America/New_York"),
    ("2026-02-28T23:59:59+00:00", "Asia/Tokyo"),
    ("2028-02-28T20:00:00+00:00", "Asia/Tokyo"),  # 29 фев в Токио
    ("2028-02-29T12:00:00+00:00", "UTC"),
    ("2027-02-28T23:00:00+00:00", "UTC"),
    ("2026-06-15T12:00:00+00:00", "Europe/Berlin"),
    ("2026-06-15T12:00:00+00:00", "UTC"),
    ("2026-07-01T00:00:00+00:00", "Europe/Berlin"),
    ("2026-12-31T22:00:00+00:00", "Europe/Berlin"),
    ("2026-04-05T12:00:00+00:00", "Pacific/Auckland"),
    ("2026-09-27T12:00:00+00:00", "Pacific/Auckland"),
]

# base + N суток: Python считает wall-clock (aware + timedelta), TS — фиксированные 24 ч.
ADD_DAYS_CASES = [
    ("2026-11-06T10:00:00+00:00", "Europe/Berlin", 1),
    ("2026-11-06T10:00:00+00:00", "Europe/Berlin", 30),
    ("2026-11-06T10:00:00+00:00", "Europe/Berlin", -1),
    ("2026-10-24T12:00:00+00:00", "Europe/Berlin", 1),  # 25 окт: DST -1 ч
    ("2026-10-24T12:00:00+00:00", "Europe/Berlin", 7),
    ("2026-03-28T12:00:00+00:00", "Europe/Berlin", 1),  # 29 мар: DST +1 ч
    ("2026-03-28T12:00:00+00:00", "Europe/Berlin", 2),
    ("2026-11-06T10:00:00+00:00", "UTC", 365),
    ("2027-12-31T23:00:00+00:00", "UTC", 1),
    ("2026-11-06T10:00:00+00:00", "America/New_York", 31),
]


def build_dates() -> dict:
    cases = []
    for index, (instant, tz) in enumerate(DATE_CASES):
        moment = datetime.fromisoformat(instant)
        local = moment.astimezone(ZoneInfo(tz))
        cases.append(
            {
                "id": f"zoned-{index}",
                "instant": moment.astimezone(timezone.utc).isoformat(),
                "timeZone": tz,
                "parts": {
                    "year": local.year,
                    "month": local.month,
                    "day": local.day,
                    "hour": local.hour,
                    "minute": local.minute,
                    "second": local.second,
                },
                "dateKey": local.strftime("%Y-%m-%d"),
                "monthKey": local.strftime("%Y-%m"),
                "timeKey": local.strftime("%H:%M"),
                "formatDate": local.strftime("%d.%m.%Y"),
                "formatDateTime": local.strftime("%d.%m.%Y %H:%M"),
            }
        )

    add_days = []
    for index, (instant, tz, days) in enumerate(ADD_DAYS_CASES):
        base = datetime.fromisoformat(instant).astimezone(ZoneInfo(tz))
        shifted = base + timedelta(days=days)
        add_days.append(
            {
                "id": f"add-days-{index}",
                "instant": datetime.fromisoformat(instant).astimezone(timezone.utc).isoformat(),
                "timeZone": tz,
                "days": days,
                "pythonIso": shifted.astimezone(timezone.utc).isoformat(),
            }
        )

    return {
        "generatedBy": "tests/parity/generate.py",
        "reference": "zoneinfo astimezone/strftime; aware datetime + timedelta",
        "now": NOW_ISO,
        "cases": cases,
        "addDaysCases": add_days,
    }


# ---------------------------------------------------------------------------
# 3. Повторы
# ---------------------------------------------------------------------------

# (id, base instant, Python-правило, TS-правило)
RECURRENCE_CASES = [
    ("daily-next-day", "2026-11-06T09:00:00+00:00", "daily", {"freq": "daily"}),
    ("daily-same-moment", "2026-11-06T10:00:00+00:00", "daily", {"freq": "daily"}),
    ("daily-far-past", "2026-01-15T07:30:00+00:00", "daily", {"freq": "daily"}),
    ("daily-tz-aware-ms", "2026-11-01T08:15:42.500000+00:00", "daily", {"freq": "daily"}),
    ("weekly", "2026-11-06T10:00:00+00:00", "weekly", {"freq": "weekly"}),
    ("weekly-past", "2026-10-02T18:00:00+00:00", "weekly", {"freq": "weekly"}),
    ("monthly-simple", "2026-10-06T09:00:00+00:00", "monthly", {"freq": "monthly"}),
    ("monthly-jan-31", "2026-01-31T09:00:00+00:00", "monthly", {"freq": "monthly"}),
    ("monthly-jan-30", "2026-01-30T09:00:00+00:00", "monthly", {"freq": "monthly"}),
    ("monthly-sticky-feb-28", "2026-02-28T09:00:00+00:00", "monthly", {"freq": "monthly"}),
    ("monthly-mar-31", "2026-03-31T09:00:00+00:00", "monthly", {"freq": "monthly"}),
    ("monthly-past-many", "2024-05-17T09:00:00+00:00", "monthly", {"freq": "monthly"}),
    ("yearly", "2026-11-06T09:00:00+00:00", "yearly", {"freq": "yearly"}),
    ("yearly-leap-day", "2024-02-29T09:00:00+00:00", "yearly", {"freq": "yearly"}),
    ("yearly-past", "2023-03-01T09:00:00+00:00", "yearly", {"freq": "yearly"}),
    ("every-2-days", "2026-11-01T09:00:00+00:00", "every_2_days", {"freq": "daily", "interval": 2}),
    ("every-10-days", "2026-10-01T09:00:00+00:00", "every_10_days", {"freq": "daily", "interval": 10}),
    ("every-3-weeks", "2026-09-01T09:00:00+00:00", "every_3_weeks", {"freq": "weekly", "interval": 3}),
    ("every-2-months", "2026-01-31T09:00:00+00:00", "every_2_months", {"freq": "monthly", "interval": 2}),
    ("every-6-months", "2026-02-28T09:00:00+00:00", "every_6_months", {"freq": "monthly", "interval": 6}),
    ("fallback-unknown-string", "2026-10-20T09:00:00+00:00", "по будням", {"freq": "monthly"}),
    ("uppercase-with-spaces", "2026-10-20T09:00:00+00:00", "  MONTHLY ", {"freq": "monthly"}),
    ("weekly-across-dst", "2026-10-18T12:00:00+02:00", "weekly", {"freq": "weekly"}),
]


def build_recurrence() -> dict:
    cases = []
    for case_id, base_iso, py_rule, ts_rule in RECURRENCE_CASES:
        base = datetime.fromisoformat(base_iso)
        nxt = calculate_next_occurrence(base, py_rule)
        cases.append(
            {
                "id": case_id,
                "base": base.astimezone(timezone.utc).isoformat(),
                "pythonRule": py_rule,
                "tsRule": ts_rule,
                "pythonIso": nxt.astimezone(timezone.utc).isoformat(),
                "pythonEpochMs": int(nxt.timestamp() * 1000),
            }
        )

    return {
        "generatedBy": "tests/parity/generate.py",
        "reference": "backend/app/services/tasks.py::calculate_next_occurrence (datetime.now зафиксирован)",
        "now": NOW_ISO,
        "cases": cases,
    }


# ---------------------------------------------------------------------------
# 4. Runway
# ---------------------------------------------------------------------------

# Счета: envelope — то, что порт хранит в колонке; Python классифицирует по имени,
# поэтому «spendable» в Python есть только у счёта со «wallet» в имени.
RUNWAY_CASES = [
    {
        "id": "empty",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [],
        "liabilities": [],
    },
    {
        "id": "single-spendable",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Wallet", "currency": "EUR", "balanceCents": 100_000, "envelope": "spendable"},
        ],
        "liabilities": [],
    },
    {
        "id": "spendable-plus-reserved",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Wallet", "currency": "EUR", "balanceCents": 100_000, "envelope": "spendable"},
            {"name": "Reserve", "currency": "EUR", "balanceCents": 50_000, "envelope": "reserved"},
        ],
        "liabilities": [],
    },
    {
        "id": "cash-rent-partial",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Cash", "currency": "EUR", "balanceCents": 60_000, "envelope": "spendable"},
            {"name": "Wallet", "currency": "EUR", "balanceCents": 100_000, "envelope": "spendable"},
        ],
        "liabilities": [
            {
                "name": "Rent",
                "queue": "queue_1",
                "currency": "EUR",
                "monthlyCents": 40_000,
                "paymentDay": 10,
                "account": "Cash",
                "paidMonths": [],
            }
        ],
    },
    {
        "id": "cash-rent-full",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Cash", "currency": "EUR", "balanceCents": 40_000, "envelope": "spendable"},
        ],
        "liabilities": [
            {
                "name": "Rent",
                "queue": "queue_1",
                "currency": "EUR",
                "monthlyCents": 40_000,
                "paymentDay": 10,
                "account": "Cash",
                "paidMonths": [],
            }
        ],
    },
    {
        "id": "cash-two-liabilities",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Cash", "currency": "EUR", "balanceCents": 100_000, "envelope": "spendable"},
            {"name": "Wallet", "currency": "EUR", "balanceCents": 45_000, "envelope": "spendable"},
        ],
        "liabilities": [
            {
                "name": "Rent",
                "queue": "queue_1",
                "currency": "EUR",
                "monthlyCents": 40_000,
                "paymentDay": 10,
                "account": "Cash",
                "paidMonths": [],
            },
            {
                "name": "Taxes",
                "queue": "queue_2",
                "currency": "EUR",
                "monthlyCents": 15_000,
                "paymentDay": 20,
                "account": "Cash",
                "paidMonths": [],
            },
        ],
    },
    {
        "id": "liability-paid-this-month",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Cash", "currency": "EUR", "balanceCents": 60_000, "envelope": "spendable"},
            {"name": "Wallet", "currency": "EUR", "balanceCents": 100_000, "envelope": "spendable"},
        ],
        "liabilities": [
            {
                "name": "Rent",
                "queue": "queue_1",
                "currency": "EUR",
                "monthlyCents": 40_000,
                "paymentDay": 10,
                "account": "Cash",
                "paidMonths": ["2026-11"],
            }
        ],
    },
    {
        "id": "different-payment-days",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Cash", "currency": "EUR", "balanceCents": 90_000, "envelope": "spendable"},
            {"name": "Wallet", "currency": "EUR", "balanceCents": 10_000, "envelope": "spendable"},
        ],
        "liabilities": [
            {
                "name": "Rent",
                "queue": "queue_1",
                "currency": "EUR",
                "monthlyCents": 30_000,
                "paymentDay": 25,
                "account": "Cash",
                "paidMonths": [],
            },
            {
                "name": "Utilities",
                "queue": "queue_2",
                "currency": "EUR",
                "monthlyCents": 10_000,
                "paymentDay": 15,
                "account": "Cash",
                "paidMonths": [],
            },
        ],
    },
    {
        "id": "horizon-override-10",
        "today": "2026-11-06",
        "horizonDays": 10,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Wallet", "currency": "EUR", "balanceCents": 100_000, "envelope": "spendable"},
        ],
        "liabilities": [],
    },
    {
        "id": "horizon-override-40",
        "today": "2026-11-06",
        "horizonDays": 40,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Cash", "currency": "EUR", "balanceCents": 80_000, "envelope": "spendable"},
            {"name": "Wallet", "currency": "EUR", "balanceCents": 20_000, "envelope": "spendable"},
        ],
        "liabilities": [
            {
                "name": "Rent",
                "queue": "queue_1",
                "currency": "EUR",
                "monthlyCents": 40_000,
                "paymentDay": 25,
                "account": "Cash",
                "paidMonths": [],
            }
        ],
    },
    {
        "id": "last-day-of-month",
        "today": "2026-11-30",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Wallet", "currency": "EUR", "balanceCents": 100_000, "envelope": "spendable"},
        ],
        "liabilities": [],
    },
    {
        "id": "last-day-february-leap",
        "today": "2028-02-29",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Wallet", "currency": "EUR", "balanceCents": 60_000, "envelope": "spendable"},
        ],
        "liabilities": [],
    },
    {
        "id": "usd-account",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Wallet", "currency": "USD", "balanceCents": 20_000, "envelope": "spendable"},
        ],
        "liabilities": [],
    },
    {
        "id": "rub-account",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Wallet", "currency": "RUB", "balanceCents": 987_654, "envelope": "spendable"},
        ],
        "liabilities": [],
    },
    {
        "id": "usd-liability-attached",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Cash", "currency": "EUR", "balanceCents": 50_000, "envelope": "spendable"},
            {"name": "Wallet", "currency": "EUR", "balanceCents": 30_000, "envelope": "spendable"},
        ],
        "liabilities": [
            {
                "name": "Hosting",
                "queue": "queue_2",
                "currency": "USD",
                "monthlyCents": 2_000,
                "paymentDay": 12,
                "account": "Cash",
                "paidMonths": [],
            }
        ],
    },
    {
        "id": "zero-and-negative-balances",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Wallet", "currency": "EUR", "balanceCents": 0, "envelope": "spendable"},
            {"name": "Reserve", "currency": "EUR", "balanceCents": 25_000, "envelope": "reserved"},
        ],
        "liabilities": [],
    },
    {
        "id": "reserved-only",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Reserve", "currency": "EUR", "balanceCents": 50_000, "envelope": "reserved"},
        ],
        "liabilities": [],
    },
    {
        "id": "burn-override-below-floor",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 50,
        "accounts": [
            {"name": "Wallet", "currency": "EUR", "balanceCents": 10_000, "envelope": "spendable"},
        ],
        "liabilities": [],
    },
    {
        "id": "burn-override-odd",
        "today": "2026-11-06",
        "horizonDays": 33,
        "dailyBurnOverrideCents": 1337,
        "accounts": [
            {"name": "Wallet", "currency": "EUR", "balanceCents": 100_001, "envelope": "spendable"},
        ],
        "liabilities": [],
    },
    {
        "id": "liability-payment-day-null",
        "today": "2026-11-06",
        "horizonDays": 15,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Wallet", "currency": "EUR", "balanceCents": 30_000, "envelope": "spendable"},
        ],
        "liabilities": [
            {
                "name": "Loan",
                "queue": "queue_3",
                "currency": "EUR",
                "monthlyCents": 5_000,
                "paymentDay": None,
                "account": "Wallet",
                "paidMonths": [],
            }
        ],
    },
    {
        "id": "liability-zero-monthly",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Wallet", "currency": "EUR", "balanceCents": 30_000, "envelope": "spendable"},
        ],
        "liabilities": [
            {
                "name": "Old loan",
                "queue": "queue_4",
                "currency": "EUR",
                "monthlyCents": 0,
                "paymentDay": 15,
                "account": None,
                "paidMonths": [],
            }
        ],
    },
    {
        "id": "payment-day-31-in-november",
        "today": "2026-11-06",
        "horizonDays": 30,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Cash", "currency": "EUR", "balanceCents": 70_000, "envelope": "spendable"},
        ],
        "liabilities": [
            {
                "name": "Rent",
                "queue": "queue_1",
                "currency": "EUR",
                "monthlyCents": 60_000,
                "paymentDay": 31,
                "account": "Cash",
                "paidMonths": [],
            }
        ],
    },
    {
        "id": "unattached-eur-rent",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Cash", "currency": "EUR", "balanceCents": 100_000, "envelope": "spendable"},
            {"name": "Wallet", "currency": "EUR", "balanceCents": 20_000, "envelope": "spendable"},
        ],
        "liabilities": [
            {
                "name": "Rent",
                "queue": "queue_1",
                "currency": "EUR",
                "monthlyCents": 30_000,
                "paymentDay": 10,
                "account": None,
                "paidMonths": [],
            }
        ],
    },
    {
        "id": "overdue-payment-day",
        "today": "2026-11-06",
        "horizonDays": None,
        "dailyBurnOverrideCents": 2000,
        "accounts": [
            {"name": "Cash", "currency": "EUR", "balanceCents": 60_000, "envelope": "spendable"},
            {"name": "Wallet", "currency": "EUR", "balanceCents": 20_000, "envelope": "spendable"},
        ],
        "liabilities": [
            {
                "name": "Rent",
                "queue": "queue_1",
                "currency": "EUR",
                "monthlyCents": 40_000,
                "paymentDay": 1,
                "account": "Cash",
                "paidMonths": [],
            }
        ],
    },
    {
        "id": "big-balances",
        "today": "2026-11-06",
        "horizonDays": 90,
        "dailyBurnOverrideCents": 7400,
        "accounts": [
            {"name": "Wallet", "currency": "EUR", "balanceCents": 9_876_543, "envelope": "spendable"},
            {"name": "Reserve", "currency": "EUR", "balanceCents": 1_234_567, "envelope": "reserved"},
            {"name": "Cash", "currency": "EUR", "balanceCents": 555_555, "envelope": "spendable"},
        ],
        "liabilities": [
            {
                "name": "Rent",
                "queue": "queue_1",
                "currency": "EUR",
                "monthlyCents": 120_000,
                "paymentDay": 9,
                "account": "Cash",
                "paidMonths": [],
            },
            {
                "name": "Internet",
                "queue": "queue_2",
                "currency": "EUR",
                "monthlyCents": 3_999,
                "paymentDay": 9,
                "account": "Cash",
                "paidMonths": [],
            },
        ],
    },
]


def _py_liability_rows(case: dict) -> list[dict]:
    """Строки `ag.liabilities` в том же виде, что отдал бы Postgres (dict)."""
    rows = []
    for index, liability in enumerate(case["liabilities"]):
        rows.append(
            {
                "id": f"liab-{index + 1}",
                "name": liability["name"],
                "queue": liability["queue"],
                "currency": liability["currency"],
                "amount": liability["monthlyCents"] / 100,
                "amount_eur": None,
                "monthly_payment": liability["monthlyCents"] / 100,
                "payment_day": liability["paymentDay"],
                "paid_months": list(liability["paidMonths"]),
                "account_id": None,
            }
        )
    return rows


def _py_account_rows(case: dict) -> tuple[list[dict], dict[str, str]]:
    """Строки `ag.accounts` + соответствие «имя счёта → id» для liabilities."""
    rows = []
    ids: dict[str, str] = {}
    for index, account in enumerate(case["accounts"]):
        account_id = f"acc-{index + 1}"
        ids[account["name"]] = account_id
        rows.append(
            {
                "id": account_id,
                "name": account["name"],
                "currency": account["currency"],
                "current_balance": account["balanceCents"] / 100,
            }
        )
    return rows, ids


async def build_runway() -> dict:
    out_cases = []
    for case in RUNWAY_CASES:
        account_rows, account_ids = _py_account_rows(case)
        liability_rows = _py_liability_rows(case)
        for liability, row in zip(case["liabilities"], liability_rows):
            if liability["account"]:
                row["account_id"] = account_ids[liability["account"]]

        conn = FakeConn(account_rows, liability_rows)
        runway_service.get_db_pool = lambda conn=conn: _async_value(_FakePool(conn))  # type: ignore[assignment]

        result = await calculate_runway(
            telegram_id=1,
            daily_burn_override=case["dailyBurnOverrideCents"] / 100,
            horizon_days=case["horizonDays"],
            today=date.fromisoformat(case["today"]),
        )

        out_cases.append(
            {
                **case,
                "accounts": [
                    {
                        **account,
                        "pythonEnvelope": _python_envelope(
                            result, account["name"], account["balanceCents"]
                        ),
                    }
                    for account in case["accounts"]
                ],
                "python": {
                    "horizonDays": result["horizon_days"],
                    "daysRemainingInMonth": result["days_remaining_in_month"],
                    "totalLiquidCents": cents(result["total_liquid_eur"]),
                    "spendableCents": cents(result["spendable_eur"]),
                    "reservedCents": cents(result["reserved_eur"]),
                    "cashReserveCents": cents(result["cash_reserve_eur"]),
                    "pendingThisMonthCents": cents(result["pending_debt_this_month_eur"]),
                    "pendingHorizonCents": cents(result["pending_debt_horizon_eur"]),
                    "reservedGapCents": cents(result["reserved_gap_eur"]),
                    "totalMonthlyObligationsCents": cents(result["total_monthly_obligations_eur"]),
                    "netLiquidCents": cents(result["net_liquid_eur"]),
                    "dailyBurnCents": cents(result["daily_burn_eur"]),
                    "safeDailyCents": cents(result["safe_daily_spend_eur"]),
                    "safeWeeklyCents": cents(result["safe_weekly_spend_eur"]),
                    "safeMonthlyCents": cents(result["safe_monthly_spend_eur"]),
                    "runwayDays": result["runway_days"],
                    "runwayWeeks": result["runway_weeks"],
                    "alreadyPaid": list(result["already_paid"]),
                    "upcoming": [
                        {"name": item["name"], "paymentDay": item["payment_day"]}
                        for item in result["upcoming_payments"]
                    ],
                    "accountEnvelopes": {
                        item["name"]: item["envelope"] for item in result["accounts"]
                    },
                },
            }
        )

    return {
        "generatedBy": "tests/parity/generate.py",
        "reference": "backend/app/services/runway.py::calculate_runway (БД и fx заглушены, today задан)",
        "now": NOW_ISO,
        "rates": RATES,
        "cases": out_cases,
    }


async def _async_value(value):
    return value


def _python_envelope(result: dict, account_name: str, balance_cents: int) -> str:
    """Конверт из Python-ответа (для наглядности; в тестах не сравнивается)."""
    for item in result["accounts"]:
        if item["name"] == account_name:
            return str(item["envelope"])
    return "zero" if balance_cents <= 0 else "unknown"


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def dump(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    path.write_text(text, encoding="utf-8")
    print(f"wrote {path.relative_to(REPO)}")


async def main() -> None:
    install_stubs()
    dump(FIXTURES / "money.json", await build_money())
    dump(FIXTURES / "dates.json", build_dates())
    dump(FIXTURES / "recurrence.json", build_recurrence())
    dump(FIXTURES / "runway.json", await build_runway())


if __name__ == "__main__":
    asyncio.run(main())

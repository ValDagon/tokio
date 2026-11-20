/**
 * POST /api/finances/undo — отмена последней финансовой операции.
 *
 * Порт `backend/app/api/routes.py::undo_transaction_api` +
 * `backend/app/agent/tools/finances.py::undo_last_transaction`:
 *  - отменяет последнюю операцию (расход/доход/перевод/обмен) и восстанавливает баланс;
 *  - `undoLastTransaction` возвращает удалённую строку или `null`;
 *  - текст сообщения повторяет upstream (включая формат чисел `1,234.56`).
 *
 * Отличия от upstream (задокументированы в T16):
 *  - upstream читает имя/валюту/новый баланс счёта в том же SQL-запросе до
 *    удаления операции; здесь баланс перечитывается через `getAccount` уже
 *    после отката (это и есть новое состояние);
 *  - конверсионный суффикс `(+X CUR)` показываем только когда валюта операции
 *    отличается от валюты счёта и есть курс (upstream использовал fallback-курс).
 */

import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import {
  EXCHANGE_TOPUP_SUFFIX,
  findLastTransaction,
  getAccount,
  getTransactionGroup,
  undoLastTransaction,
} from '../lib/dal/finances.js';
import { convert, getRates, hasRate } from '../lib/dal/fx.js';
import { formatCents } from '../lib/utils.js';

export interface UndoResponse {
  status: 'ok';
  message: string;
}

async function conversionSuffix(
  sign: '+' | '-',
  amountCents: number,
  fromCurrency: string,
  toCurrency: string,
): Promise<string> {
  if (fromCurrency.toUpperCase() === toCurrency.toUpperCase()) return '';
  try {
    const rates = await getRates();
    if (!hasRate(fromCurrency, rates) || !hasRate(toCurrency, rates)) return '';
    const converted = convert(amountCents, fromCurrency, toCurrency, rates);
    return ` (${sign}${formatCents(converted)} ${toCurrency})`;
  } catch {
    return '';
  }
}

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<UndoResponse> {
  const userId = requireUserId(input, ctx);

  // Группу обмена читаем до отката: после него строк уже нет.
  const last = await findLastTransaction(userId);
  const exchangeLegs =
    last?.kind === 'exchange' && last.transferGroupId
      ? await getTransactionGroup(userId, last.transferGroupId)
      : [];

  const transaction = await undoLastTransaction(userId);
  if (!transaction) {
    return { status: 'ok', message: 'Не найдено операций для отмены.' };
  }

  const amount = formatCents(transaction.amountCents);
  // Сколько вернулось на счёт на самом деле: при недокрытии часть суммы не
  // была списана, её компенсирует служебная строка группы.
  const uncoveredCents = transaction.uncoveredCents ?? 0;
  const returnedCents = transaction.amountCents - uncoveredCents;
  const returned = formatCents(returnedCents);
  const currency = transaction.currency;
  const description = transaction.description ?? '';

  if (transaction.kind === 'expense' || transaction.kind === 'income') {
    const account = await getAccount(userId, transaction.accountId);
    const accountName = account?.name ?? '';
    const accountCurrency = account?.currency ?? currency;
    const newBalance = formatCents(account?.currentBalanceCents ?? 0);
    const suffix = await conversionSuffix(
      transaction.kind === 'expense' ? '+' : '-',
      returnedCents,
      currency,
      accountCurrency,
    );
    const action =
      transaction.kind === 'expense'
        ? 'Последняя операция успешно отменена'
        : 'Последняя операция отменена';
    const balanceVerb = transaction.kind === 'expense' ? 'восстановлен' : 'скорректирован';
    const returnedNote =
      uncoveredCents > 0 ? `, на счёт вернулось ${returned} ${currency}` : '';
    return {
      status: 'ok',
      message:
        `↩️ ${action}: ${transaction.kind === 'expense' ? 'расход' : 'доход'} ${amount} ${currency} («${description}»)${returnedNote}.\n` +
        `Баланс счёта «${accountName} (${accountCurrency})» ${balanceVerb}${suffix}: ${newBalance} ${accountCurrency}.`,
    };
  }

  if (transaction.kind === 'exchange') {
    // Ноги добора с расчётного счёта — технические: в сообщении показываем
    // только исходящую и входящую.
    const legs = exchangeLegs.filter(
      (leg) => !(leg.description ?? '').endsWith(EXCHANGE_TOPUP_SUFFIX),
    );
    const outLeg = legs.find((leg) => leg.amountCents < 0);
    const inLeg = legs.find((leg) => leg.amountCents > 0);
    if (outLeg && inLeg) {
      return {
        status: 'ok',
        message:
          `↩️ Обмен ${formatCents(Math.abs(outLeg.amountCents))} ${outLeg.currency} → ` +
          `${formatCents(inLeg.amountCents)} ${inLeg.currency} отменён, ` +
          'балансы счетов восстановлены.',
      };
    }
  }

  if (transaction.kind === 'transfer') {
    return {
      status: 'ok',
      message:
        `↩️ Операция перевода «${description}» на сумму ${amount} ${currency} отменена, ` +
        'балансы счетов восстановлены.',
    };
  }

  return { status: 'ok', message: `↩️ Операция «${description}» удалена.` };
}

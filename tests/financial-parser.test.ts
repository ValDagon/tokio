import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetOverlayOverride, setOverlayOverride, type OverlayOverride } from '../src/lib/overlay.js';
import {
  BalanceAccountUnresolvedError,
  buildBalanceIntentFromSegments,
  detectCategoryFromText,
  executeFinancialIntent,
  matchExplicitAccount,
  parseFinancialIntent,
  resolveAccountFromContext,
  resolveCurr,
  UnsupportedCurrencyError,
} from '../src/lib/financial-parser.js';
import {
  ensureAccounts,
  deleteTransaction,
  findAccountByName,
  getAccount,
  listAccounts,
  listTransactions,
} from '../src/lib/dal/finances.js';
import { ensureUser } from '../src/lib/dal/users.js';
import { getNote, listNotes } from '../src/lib/dal/notes.js';
import { resetDb, setBeginBlocked, sqliteDDL } from './mocks/sdk.js';
import { createTableStatements } from '../src/lib/db/ddl.js';
import { TABLES } from '../src/lib/db/tables.js';

describe('financial-parser', () => {
  beforeEach(() => {
    setOverlayOverride({
      manifest: {
        finance: {
          accountAliases: [
            { account: 'AlphaBank', patterns: ['alpha', 'альфа', 'ab'] },
            { account: 'CryptoX', patterns: ['cryptox', 'крипто'] },
            { account: 'CardOne', patterns: ['cardone', 'кардван'] },
            { account: 'Наличные', patterns: ['cash', 'кэш', 'налич'] },
          ],
          defaultAccountByCurrency: {
            EUR: 'Наличные',
            USD: 'CryptoX',
            RUB: 'CardOne',
            KZT: 'AlphaBank',
            TRY: 'AlphaBank',
          },
          genericCardAccountByCurrency: {
            EUR: 'AlphaBank',
            USD: 'AlphaBank',
            RUB: 'CardOne',
            KZT: 'AlphaBank',
            TRY: 'AlphaBank',
          },
        },
      },
    } as unknown as OverlayOverride);
  });

  afterEach(() => {
    resetOverlayOverride();
  });

  describe('resolveCurr', () => {
    it('распознает различные варианты валют', () => {
      expect(resolveCurr('€')).toBe('EUR');
      expect(resolveCurr('евро')).toBe('EUR');
      expect(resolveCurr('eur')).toBe('EUR');
      expect(resolveCurr('$')).toBe('USD');
      expect(resolveCurr('доллар')).toBe('USD');
      expect(resolveCurr('бакс')).toBe('USD');
      expect(resolveCurr('usdt')).toBe('USD');
      expect(resolveCurr('₽')).toBe('RUB');
      expect(resolveCurr('руб')).toBe('RUB');
      expect(resolveCurr('р')).toBe('RUB');
      expect(resolveCurr('₸')).toBe('KZT');
      expect(resolveCurr('тенге')).toBe('KZT');
      expect(resolveCurr('тг')).toBe('KZT');
      expect(resolveCurr('₺')).toBe('TRY');
      expect(resolveCurr('лиры')).toBe('TRY');
      expect(resolveCurr(null, 'EUR')).toBe('EUR');
    });

    it('an unsupported ISO currency is refused by name, never converted to EUR', () => {
      // Незнакомый код не выдаёт себя за евро: отказ называет исходную валюту.
      let thrown: unknown = null;
      try {
        buildBalanceIntentFromSegments([
          { account: 'UBS', amountCents: 123_00, currency: 'CHF' },
        ]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UnsupportedCurrencyError);
      const refusal = thrown as UnsupportedCurrencyError;
      expect(refusal.code).toBe('CHF');
      expect(refusal.message).toContain('CHF');
      // Суммы в евро из «CHF» не появилось.
      expect(refusal.message).not.toContain('EUR');

      // Известные валюты и текстовый (он же голосовой) путь не изменились.
      const usd = buildBalanceIntentFromSegments([
        { account: 'CryptoX', amountCents: 1_000, currency: 'USD' },
      ]);
      expect(usd?.currency).toBe('USD');
      const text = parseFinancialIntent('У меня 50€ наличными и 100$ на крипто');
      expect(text?.action).toBe('balance');
      expect(text?.currency).toBe('EUR');
      expect(text?.balances?.map((entry) => entry.currency)).toEqual(['EUR', 'USD']);
    });
  });

  describe('resolveAccountFromContext', () => {
    it('выбирает аккаунт по тексту и валюте', () => {
      expect(resolveAccountFromContext('с AlphaBank', 'EUR')).toBe('AlphaBank');
      expect(resolveAccountFromContext('на альфа', 'USD')).toBe('AlphaBank');
      expect(resolveAccountFromContext('на крипто', 'USD')).toBe('CryptoX');
      expect(resolveAccountFromContext('через CardOne', 'RUB')).toBe('CardOne');
      expect(resolveAccountFromContext('наличка', 'EUR')).toBe('Наличные');
      // Defaults by currency
      expect(resolveAccountFromContext(null, 'EUR')).toBe('Наличные');
      expect(resolveAccountFromContext(null, 'USD')).toBe('CryptoX');
      expect(resolveAccountFromContext(null, 'RUB')).toBe('CardOne');
      expect(resolveAccountFromContext(null, 'KZT')).toBe('AlphaBank');
    });

    it('matchExplicitAccount с strictBrandOnly: true пропускает общий fallback по словам «карта» и «счёт»', () => {
      expect(matchExplicitAccount('Карта *1234', 'RUB')).toBe('CardOne');
      expect(matchExplicitAccount('Карта *1234', 'RUB', { strictBrandOnly: true })).toBeNull();
      expect(matchExplicitAccount('Накопительный счёт', 'RUB', { strictBrandOnly: true })).toBeNull();
      expect(matchExplicitAccount('AlphaBank *1234', 'RUB', { strictBrandOnly: true })).toBe(
        'AlphaBank',
      );
      expect(matchExplicitAccount('CardOne', 'RUB', { strictBrandOnly: true })).toBe('CardOne');
    });
  });

  describe('detectCategoryFromText', () => {
    it('определяет категорию по ключевым словам', () => {
      expect(detectCategoryFromText('кофе')).toBe('Кафе');
      expect(detectCategoryFromText('вкусный обед в кафе')).toBe('Кафе');
      expect(detectCategoryFromText('такси до дома')).toBe('Транспорт');
      expect(detectCategoryFromText('продукты пятерочка')).toBe('Супермаркет');
      expect(detectCategoryFromText('таблетки в аптеке')).toBe('Аптека');
      expect(detectCategoryFromText('подписка vpn')).toBe('Подписки');
      expect(detectCategoryFromText('купил обувь')).toBe('Покупки');
      expect(detectCategoryFromText('зарплата за месяц')).toBe('Доходы');
      expect(detectCategoryFromText('что-то непонятное')).toBe('Разное');
    });
  });

  describe('parseFinancialIntent', () => {
    it('распознает «500 кофе» и «кофе 500»', () => {
      const e1 = parseFinancialIntent('500 кофе', 'RUB');
      expect(e1).not.toBeNull();
      expect(e1?.action).toBe('expense');
      expect(e1?.type).toBe('expense');
      expect(e1?.amount).toBe(500);
      expect(e1?.currency).toBe('RUB');
      expect(e1?.description.toLowerCase()).toContain('кофе');
      expect(e1?.category).toBe('Кафе');

      const e2 = parseFinancialIntent('кофе 500', 'RUB');
      expect(e2).not.toBeNull();
      expect(e2?.action).toBe('expense');
      expect(e2?.amount).toBe(500);
      expect(e2?.currency).toBe('RUB');
      expect(e2?.description.toLowerCase()).toContain('кофе');
      expect(e2?.category).toBe('Кафе');
    });

    it('распознает «+1000 зарплата»', () => {
      const inc = parseFinancialIntent('+1000 зарплата', 'RUB');
      expect(inc).not.toBeNull();
      expect(inc?.action).toBe('income');
      expect(inc?.type).toBe('income');
      expect(inc?.amount).toBe(1000);
      expect(inc?.currency).toBe('RUB');
      expect(inc?.description.toLowerCase()).toContain('зарплата');
      expect(inc?.category).toBe('Доходы');
    });

    it('распознает «15.50 eur обед»', () => {
      const e = parseFinancialIntent('15.50 eur обед');
      expect(e).not.toBeNull();
      expect(e?.action).toBe('expense');
      expect(e?.amount).toBe(15.5);
      expect(e?.currency).toBe('EUR');
      expect(e?.description.toLowerCase()).toContain('обед');
      expect(e?.category).toBe('Кафе');
    });

    it('распознает синтаксис расходов с минусом и препозициями', () => {
      const e1 = parseFinancialIntent('Запиши -10€ с AlphaBank');
      expect(e1?.action).toBe('expense');
      expect(e1?.amount).toBe(10);
      expect(e1?.currency).toBe('EUR');
      expect(e1?.account).toBe('AlphaBank');

      const e2 = parseFinancialIntent('-10€ с AlphaBank');
      expect(e2?.amount).toBe(10);
      expect(e2?.currency).toBe('EUR');

      const e3 = parseFinancialIntent('- 10 € с AlphaBank');
      expect(e3?.amount).toBe(10);

      const e4 = parseFinancialIntent('-10 eur AlphaBank');
      expect(e4?.amount).toBe(10);
      expect(e4?.currency).toBe('EUR');

      const e5 = parseFinancialIntent('Минус 10 евро с AlphaBank');
      expect(e5?.amount).toBe(10);
      expect(e5?.currency).toBe('EUR');

      const e6 = parseFinancialIntent('10€ с AlphaBank');
      expect(e6?.action).toBe('expense');
      expect(e6?.amount).toBe(10);
      expect(e6?.currency).toBe('EUR');
    });

    it('распознает глаголы расходов', () => {
      const e1 = parseFinancialIntent('Запиши расход 10€ с AlphaBank');
      expect(e1?.action).toBe('expense');
      expect(e1?.amount).toBe(10);

      const e2 = parseFinancialIntent('Потратил 15€ с CardOne');
      expect(e2?.action).toBe('expense');
      expect(e2?.amount).toBe(15);
      expect(e2?.account).toBe('CardOne');

      const e3 = parseFinancialIntent('Списали 20$ с CryptoX');
      expect(e3?.action).toBe('expense');
      expect(e3?.amount).toBe(20);
      expect(e3?.currency).toBe('USD');

      const e4 = parseFinancialIntent('Купил кофе 3 eur');
      expect(e4?.action).toBe('expense');
      expect(e4?.amount).toBe(3);
      expect(e4?.currency).toBe('EUR');
      expect(e4?.description.toLowerCase()).toBe('кофе');

      const e5 = parseFinancialIntent('Кофе 3 евро');
      expect(e5?.amount).toBe(3);
      expect(e5?.currency).toBe('EUR');
    });

    it('распознает доходы', () => {
      const i1 = parseFinancialIntent('+100€ на AlphaBank');
      expect(i1?.action).toBe('income');
      expect(i1?.amount).toBe(100);
      expect(i1?.currency).toBe('EUR');
      expect(i1?.account).toBe('AlphaBank');

      const i2 = parseFinancialIntent('Доход 500$ на CryptoX');
      expect(i2?.action).toBe('income');
      expect(i2?.amount).toBe(500);
      expect(i2?.currency).toBe('USD');

      const i3 = parseFinancialIntent('Пришло 1000 руб на CardOne');
      expect(i3?.action).toBe('income');
      expect(i3?.amount).toBe(1000);
      expect(i3?.currency).toBe('RUB');
    });

    it('распознает балансы и переводы', () => {
      const b1 = parseFinancialIntent('Баланс Alpha 50€');
      expect(b1?.action).toBe('balance');
      expect(b1?.amount).toBe(50);
      expect(b1?.currency).toBe('EUR');

      const b2 = parseFinancialIntent('Баланс CardOne 5000 руб');
      expect(b2?.action).toBe('balance');
      expect(b2?.amount).toBe(5000);
      expect(b2?.currency).toBe('RUB');

      const tr1 = parseFinancialIntent('Переведи 50€ с Alpha на Наличные');
      expect(tr1?.action).toBe('transfer');
      expect(tr1?.amount).toBe(50);
      expect(tr1?.currency).toBe('EUR');
      expect(tr1?.fromAccount).toBe('Alpha');
      expect(tr1?.toAccount).toBe('Наличные');
    });

    it('распознаёт балансы в разговорной форме («у меня X наличкой и Y на крипто»)', () => {
      const b = parseFinancialIntent('У меня 50€ наличкой и 100$ на крипто');
      expect(b?.action).toBe('balance');
      expect(b?.balances).toEqual([
        { account: 'Наличные', amount: 50, currency: 'EUR' },
        { account: 'CryptoX', amount: 100, currency: 'USD' },
      ]);
    });

    it('распознаёт баланс, когда счёт назван перед суммой', () => {
      const b = parseFinancialIntent('Наличными 50€');
      expect(b?.action).toBe('balance');
      expect(b?.amount).toBe(50);
      expect(b?.currency).toBe('EUR');
      expect(b?.account).toBe('Наличные');
    });

    it('не превращает траты и вопросы о деньгах в баланс', () => {
      expect(parseFinancialIntent('Потратил 50€ наличкой')?.action).toBe('expense');
      expect(parseFinancialIntent('Кофе 50€')?.action).toBe('expense');
      expect(parseFinancialIntent('Погасил крипто 25$')?.action).toBe('liability_pay');
      expect(parseFinancialIntent('У меня нет денег')).toBeNull();
      expect(parseFinancialIntent('У меня долг 50€')).toBeNull();
    });

    it('отклоняет нефинансовые фразы и вопросы', () => {
      expect(parseFinancialIntent('Какой баланс на счетах?')).toBeNull();
      expect(parseFinancialIntent('Напомни купить молоко')).toBeNull();
      expect(parseFinancialIntent('Привет, как дела?')).toBeNull();
      expect(parseFinancialIntent('')).toBeNull();
    });

    it('распознаёт обмен валют в русских и английских фразах', () => {
      const ru = parseFinancialIntent('поменял 100 долларов на 92 евро');
      expect(ru?.action).toBe('exchange');
      expect(ru?.fromAmount).toBe(100);
      expect(ru?.fromCurrency).toBe('USD');
      expect(ru?.toAmount).toBe(92);
      expect(ru?.toCurrency).toBe('EUR');

      const en = parseFinancialIntent('Exchanged 100 usd for 92 eur');
      expect(en?.action).toBe('exchange');
      expect(en?.fromAmount).toBe(100);
      expect(en?.fromCurrency).toBe('USD');
      expect(en?.toAmount).toBe(92);
      expect(en?.toCurrency).toBe('EUR');

      const translit = parseFinancialIntent('obmenyal 100 usd na 92 eur');
      expect(translit?.action).toBe('exchange');
      expect(translit?.fromCurrency).toBe('USD');
      expect(translit?.toCurrency).toBe('EUR');
    });

    it('распознаёт обмен между разными валютами и счётами', () => {
      const kzt = parseFinancialIntent('обменял 50000 тенге на 100 долларов с AlphaBank на CryptoX');
      expect(kzt?.action).toBe('exchange');
      expect(kzt?.fromAmount).toBe(50000);
      expect(kzt?.fromCurrency).toBe('KZT');
      expect(kzt?.toAmount).toBe(100);
      expect(kzt?.toCurrency).toBe('USD');
      expect(kzt?.fromAccount).toBe('AlphaBank');
      expect(kzt?.toAccount).toBe('CryptoX');

      const rub = parseFinancialIntent('поменял 10000 рублей на 100 евро');
      expect(rub?.action).toBe('exchange');
      expect(rub?.fromCurrency).toBe('RUB');
      expect(rub?.toCurrency).toBe('EUR');
    });

    it('отклоняет обмен, когда указана только одна сумма', () => {
      expect(parseFinancialIntent('поменял 100 долларов')).toBeNull();
      expect(parseFinancialIntent('обменял 100 usd на')).toBeNull();
      expect(parseFinancialIntent('exchanged 100 usd')).toBeNull();
      expect(parseFinancialIntent('поменял 100 долларов на 92')).toBeNull();
    });
  });

  describe('executeFinancialIntent', () => {
    const USER_ID = 999111;

    beforeEach(async () => {
      resetDb();
      sqliteDDL(createTableStatements(TABLES));
      await ensureUser(USER_ID, 'Test User');
      await ensureAccounts(USER_ID, [
        { name: 'AlphaBank', currency: 'EUR', initialBalanceCents: 10000 },
        { name: 'CardOne', currency: 'RUB', initialBalanceCents: 500000 },
      ]);
    });

    it('исполняет расход и уменьшает баланс счёта', async () => {
      const intent = parseFinancialIntent('Запиши -10€ с AlphaBank')!;
      expect(intent).not.toBeNull();

      const result = await executeFinancialIntent(USER_ID, intent, 'Запиши -10€ с AlphaBank');
      expect(result.action).toBe('expense');
      expect(result.amount).toBe(10);
      expect(result.currency).toBe('EUR');
      expect(result.transactionId).toBeDefined();
      expect(result.noteId).toBeDefined();
      expect(result.replyText).toContain('Расход зафиксирован');
      // Деньги в тексте — единым форматом бота: запятая, два знака.
      expect(result.replyText).toContain('10,00 EUR');

      // Check account balance: 10000 - 1000 = 9000 cents (90 EUR)
      const acc = await getAccount(USER_ID, 1);
      expect(acc?.currentBalanceCents).toBe(9000);

      // Check audit note
      const note = await getNote(USER_ID, result.noteId!);
      expect(note).not.toBeNull();
      expect(note?.metadata?.transaction_id).toBe(result.transactionId);
    });

    it('обновляет несколько счетов одним сообщением', async () => {
      const text = 'У меня 50€ наличкой и 100$ на крипто';
      const intent = parseFinancialIntent(text)!;
      expect(intent).not.toBeNull();

      const result = await executeFinancialIntent(USER_ID, intent, text);
      expect(result.action).toBe('balance');
      expect(result.replyText).toContain('Балансы обновлены');

      const cash = await findAccountByName(USER_ID, 'Наличные', 'EUR');
      expect(cash?.currentBalanceCents).toBe(5000);

      const cryptoWallet = await findAccountByName(USER_ID, 'CryptoX', 'USD');
      expect(cryptoWallet?.currentBalanceCents).toBe(10000);

      const note = await getNote(USER_ID, result.noteId!);
      expect(note).not.toBeNull();
      expect(note?.metadata?.balances).toHaveLength(2);
    });

    it('requireExistingAccount blocks auto-creating an account', async () => {
      // Снимок с уже сопоставленным именем счёта: так приходит фото-путь.
      const intent = buildBalanceIntentFromSegments([
        { account: 'BankTwo', amountCents: 770_000, currency: 'RUB' },
      ])!;
      expect(intent.action).toBe('balance');

      const before = await listAccounts(USER_ID);
      const notesBefore = await listNotes(USER_ID);
      const txBefore = await listTransactions(USER_ID);

      // Строгий режим (фото): незнакомый банк не заводит счёт-призрак.
      let thrown: unknown = null;
      try {
        await executeFinancialIntent(USER_ID, intent, 'Баланс BankTwo 7700 руб', {
          requireExistingAccount: true,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(BalanceAccountUnresolvedError);
      const unresolved = thrown as BalanceAccountUnresolvedError;
      // Причина названа: счёт и валюта из снимка.
      expect(unresolved.accountName).toBe('BankTwo');
      expect(unresolved.currency).toBe('RUB');
      expect(unresolved.message).toContain('Не удалось сопоставить счёт');

      // Ничего не создано и не записано.
      const after = await listAccounts(USER_ID);
      expect(after.map((account) => [account.name, account.currency])).toEqual(
        before.map((account) => [account.name, account.currency]),
      );
      expect(await listNotes(USER_ID)).toHaveLength(notesBefore.length);
      expect(await listTransactions(USER_ID)).toHaveLength(txBefore.length);

      // Без флага тот же снимок по-прежнему заводит счёт: гейт — опция, не путь.
      const created = await executeFinancialIntent(USER_ID, intent, 'Баланс BankTwo 7700 руб');
      expect(created.action).toBe('balance');
      const bankTwo = await findAccountByName(USER_ID, 'BankTwo', 'RUB');
      expect(bankTwo?.currentBalanceCents).toBe(770_000);
    });

    it('расход больше остатка: проводится целиком, без минуса, разница помечена', async () => {
      await ensureAccounts(USER_ID, [
        { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 1000 },
      ]);

      const text = 'потратил 150 eur с AlphaBank';
      const intent = parseFinancialIntent(text)!;
      expect(intent.action).toBe('expense');

      // Как на tgcloud: BEGIN заблокирован, откат только ручной.
      setBeginBlocked(true);

      const result = await executeFinancialIntent(USER_ID, intent, text);
      expect(result.replyText).toContain('Расход зафиксирован');
      expect(result.replyText).toContain('непокрытая разница');

      // Расход записан целиком — факт траты не теряется.
      const txs = await listTransactions(USER_ID);
      const expense = txs.find((tx) => tx.kind === 'expense');
      expect(expense?.amountCents).toBe(15000);

      // Балансы в ноль, но не в минус: 100 EUR + 10 KZT покрыли 102 EUR.
      const eur = await findAccountByName(USER_ID, 'AlphaBank', 'EUR');
      const kzt = await findAccountByName(USER_ID, 'AlphaBank', 'KZT');
      expect(eur?.currentBalanceCents).toBe(0);
      expect(kzt?.currentBalanceCents).toBe(0);

      // Движения по расходу — отдельные служебные строки той же группы.
      const movement = txs.filter((tx) => tx.kind === 'adjustment');
      expect(movement.length).toBeGreaterThan(0);
      expect(movement.every((row) => row.amountCents < 0)).toBe(true);
      expect(movement.every((row) => row.transferGroupId === expense?.transferGroupId)).toBe(true);
      expect(movement.reduce((sum, row) => sum + row.amountCents, 0)).toBeLessThan(0);
    });

    it('отмена такого расхода возвращает ровно списанное', async () => {
      await ensureAccounts(USER_ID, [
        { name: 'AlphaBank', currency: 'KZT', initialBalanceCents: 1000 },
      ]);
      const text = 'потратил 150 eur с AlphaBank';
      const intent = parseFinancialIntent(text)!;
      setBeginBlocked(true);

      const result = await executeFinancialIntent(USER_ID, intent, text);
      await deleteTransaction(USER_ID, result.transactionId!);

      const eur = await findAccountByName(USER_ID, 'AlphaBank', 'EUR');
      const kzt = await findAccountByName(USER_ID, 'AlphaBank', 'KZT');
      expect(eur?.currentBalanceCents).toBe(10000);
      expect(kzt?.currentBalanceCents).toBe(1000);
      expect(await listTransactions(USER_ID)).toHaveLength(0);
    });

    it('перевод больше остатка по-прежнему отказывает и не оставляет строк', async () => {
      await ensureAccounts(USER_ID, [
        { name: 'CryptoX', currency: 'EUR', initialBalanceCents: 0 },
      ]);
      const text = 'Переведи 150€ с AlphaBank на CryptoX';
      const intent = parseFinancialIntent(text)!;
      expect(intent.action).toBe('transfer');

      setBeginBlocked(true);

      await expect(executeFinancialIntent(USER_ID, intent, text)).rejects.toMatchObject({
        name: 'InsufficientFundsError',
        accountName: 'AlphaBank',
        currency: 'EUR',
        requiredCents: 15000,
        availableCents: 10000,
      });

      expect(await listTransactions(USER_ID)).toHaveLength(0);
      expect(await listNotes(USER_ID)).toHaveLength(0);
      const eur = await findAccountByName(USER_ID, 'AlphaBank', 'EUR');
      expect(eur?.currentBalanceCents).toBe(10000);
    });

    it('исполняет доход и увеличивает баланс счёта', async () => {
      const intent = parseFinancialIntent('Пришло 1000 руб на CardOne')!;
      expect(intent).not.toBeNull();

      const result = await executeFinancialIntent(USER_ID, intent, 'Пришло 1000 руб на CardOne');
      expect(result.action).toBe('income');
      expect(result.amount).toBe(1000);
      expect(result.currency).toBe('RUB');
      expect(result.replyText).toContain('Доход зафиксирован');

      // Check transactions
      const txs = await listTransactions(USER_ID);
      expect(txs.length).toBe(1);
      expect(txs[0]?.kind).toBe('income');
      expect(txs[0]?.amountCents).toBe(100000); // 1000 RUB in cents
    });

    it('исполняет обмен двумя строками kind=exchange', async () => {
      await ensureAccounts(USER_ID, [
        { name: 'CryptoX', currency: 'USD', initialBalanceCents: 10000 },
        { name: 'Наличные', currency: 'EUR', initialBalanceCents: 0 },
      ]);

      const text = 'поменял 100 долларов на 92 евро';
      const intent = parseFinancialIntent(text)!;
      expect(intent.action).toBe('exchange');

      const result = await executeFinancialIntent(USER_ID, intent, text);
      expect(result.action).toBe('exchange');
      expect(result.transactionId).toBeDefined();
      expect(result.replyText).toContain('Обмен зафиксирован');

      const txs = await listTransactions(USER_ID);
      const legs = txs.filter((tx) => tx.kind === 'exchange');
      expect(legs).toHaveLength(2);
      const groupIds = new Set(legs.map((tx) => tx.transferGroupId));
      expect(groupIds.size).toBe(1);
      expect([...groupIds][0]).toBeTruthy();
      expect(legs.some((tx) => tx.amountCents < 0 && tx.currency === 'USD')).toBe(true);
      expect(legs.some((tx) => tx.amountCents > 0 && tx.currency === 'EUR')).toBe(true);

      const note = await getNote(USER_ID, result.noteId!);
      expect(note).not.toBeNull();
      expect(note?.metadata?.from_currency).toBe('USD');
      expect(note?.metadata?.to_currency).toBe('EUR');
    });
  });
});

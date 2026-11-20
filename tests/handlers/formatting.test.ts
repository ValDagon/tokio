/**
 * T14 — порт `legacy/backend/app/bot/formatting.py`.
 *
 * Фиксируем то, что легко сломать незаметно: экранирование `html.escape(quote=False)`,
 * порядок шагов Markdown-конвейера, запрет резать `<pre>` без нужды и три
 * сценария безопасной отправки — фолбэк без `parse_mode`, ретрай на 429
 * (без сна — в изоляте нет `setTimeout`) и `message is not modified`.
 */

import { describe, expect, it } from 'vitest';

import {
  escapeAmpLtGt,
  findProtectedSpans,
  formatQuotePreview,
  isNumericColumn,
  isNumericOrCurrency,
  markdownToTelegramHtml,
  safeAnswer,
  safeEdit,
  safeSendMessage,
  splitMessageChunks,
  TARGET_CHUNK_LENGTH,
} from '../../src/handlers/formatting';

/**
 * Ошибка Bot API для тестовых заглушек: у платформенного `BotApiError` в
 * декларации нет публичного конструктора, а `formatting` опознаёт ошибку по
 * полям `code`/`description`.
 */
function apiError(method: string, code: number, description: string): Error {
  return Object.assign(new Error(`${method} failed: ${code} ${description}`), {
    name: 'BotApiError',
    method,
    code,
    description,
    parameters: {} as Record<string, unknown>,
  });
}

describe('escapeAmpLtGt', () => {
  it('экранирует только & < > и амперсанд первым', () => {
    expect(escapeAmpLtGt('a & b < c > d "q" \'s\'')).toBe(
      'a &amp; b &lt; c &gt; d "q" \'s\'',
    );
    expect(escapeAmpLtGt('&lt;')).toBe('&amp;lt;');
  });
});

describe('formatQuotePreview', () => {
  it('короткий текст отдаёт без изменений (trim)', () => {
    expect(formatQuotePreview('  привет  ')).toBe('привет');
  });

  it('длинный текст режет и сообщает реальную длину', () => {
    const text = 'a'.repeat(12);
    const preview = formatQuotePreview(text, 5);
    expect(preview).toBe('aaaaa... [всего 12 символов, сохранено в Инбокс]');
  });
});

describe('колонки таблиц', () => {
  it('узнаёт числа, валюты и нейтральные заглушки', () => {
    expect(isNumericOrCurrency('1 200')).toBe(true);
    expect(isNumericOrCurrency('~40')).toBe(true);
    expect(isNumericOrCurrency('12 €')).toBe(true);
    expect(isNumericOrCurrency('EUR')).toBe(true);
    expect(isNumericOrCurrency('обед')).toBe(false);

    expect(isNumericColumn(['1', '-', 'N/A'])).toBe(true);
    expect(isNumericColumn(['-', '?'])).toBe(false);
    expect(isNumericColumn(['1', 'обед'])).toBe(false);
    expect(isNumericColumn([])).toBe(false);
  });
});

describe('markdownToTelegramHtml', () => {
  it('пустая строка — пустой результат', () => {
    expect(markdownToTelegramHtml('')).toBe('');
  });

  it('заголовок, жирный, курсив, зачёркнутый и инлайн-код', () => {
    const html = markdownToTelegramHtml('## Итог\n**важно** и *курсив*, ~~старое~~, `x < 1`');
    expect(html).toContain('<b>Итог</b>');
    expect(html).toContain('<b>важно</b>');
    expect(html).toContain('<i>курсив</i>');
    expect(html).toContain('<s>старое</s>');
    expect(html).toContain('<code>x &lt; 1</code>');
  });

  it('snake_case не превращается в курсив', () => {
    expect(markdownToTelegramHtml('base_currency и max_tokens')).toBe('base_currency и max_tokens');
  });

  it('код-блок с языком и экранированием', () => {
    const html = markdownToTelegramHtml('```ts\nconst a = 1 < 2;\n```');
    expect(html).toBe('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
  });

  it('ссылки, спойлеры и чекбоксы', () => {
    const html = markdownToTelegramHtml('[док](https://example.com) ||тайна||\n- [ ] дело\n- [x] готово');
    expect(html).toContain('<a href="https://example.com">док</a>');
    expect(html).toContain('<tg-spoiler>тайна</tg-spoiler>');
    expect(html).toContain('☐ дело');
    expect(html).toContain('✅ готово');
  });

  it('пользовательский текст экранируется, разметка — нет', () => {
    const html = markdownToTelegramHtml('<script>alert(1)</script> **ok**');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<b>ok</b>');
  });

  // 1:1 с upstream: `render_proportional_table` рисует только строки данных,
  // строка заголовка и разделитель отбрасываются.
  it('GFM-таблица превращается в пропорциональные пункты', () => {
    const html = markdownToTelegramHtml(
      '| Счёт | Баланс |\n|---|---|\n| Кошелёк | 100 € |\n| Банк | 1 200 € · EUR |',
    );
    expect(html).toBe('• <b>Кошелёк</b>: 100 €\n• <b>Банк</b>: 1 200 € · EUR');
    expect(html).not.toContain('<pre>');
    expect(html).not.toContain('|---');
  });

  // Модель иногда опускает строку-разделитель: таблица всё равно должна стать
  // списком, а не пройти в чат сырыми трубами. Заголовок отбрасывается так же,
  // как разделитель.
  it('таблица без строки-разделителя всё равно становится списком', () => {
    const html = markdownToTelegramHtml(
      '| Дата | Сервис | Сумма |\n| 18 ноября | Google AI Pro | 2 490 ₸ |\n| 20 ноября | GeForce NOW | 19.99 $ |',
    );
    expect(html).not.toContain('|');
    expect(html).not.toContain(':---');
    expect(html).toContain('Google AI Pro');
    expect(html).toContain('2 490 ₸');
    expect(html.split('\n').filter((line) => line.startsWith('• '))).toHaveLength(2);
    expect(html).toBe(
      '• <b>18 ноября</b>: Google AI Pro · 2 490 ₸\n• <b>20 ноября</b>: GeForce NOW · 19.99 $',
    );
  });

  it('заголовок третьего уровня становится жирной строкой', () => {
    expect(markdownToTelegramHtml('### Итог')).toBe('<b>Итог</b>');
  });

  it('цитата из четырёх строк — раскрывающаяся', () => {
    const html = markdownToTelegramHtml('> раз\n> два\n> три\n> четыре');
    expect(html).toBe('<blockquote expandable>раз\nдва\nтри\nчетыре</blockquote>');
  });

  it('короткая цитата — обычная', () => {
    expect(markdownToTelegramHtml('> одна строка')).toBe('<blockquote>одна строка</blockquote>');
  });

  it('курсив _…_ не ломается о вложенные спойлер, код, HTML-теги и snake_case', () => {
    expect(
      markdownToTelegramHtml(
        '_⚠️ Отложенных дел в бэклоге: ||5 шт.|| (разберём, когда будет ресурс)_',
      ),
    ).toBe(
      '<i>⚠️ Отложенных дел в бэклоге: <tg-spoiler>5 шт.</tg-spoiler> (разберём, когда будет ресурс)</i>',
    );
    expect(markdownToTelegramHtml('_||тайна||_')).toBe('<i><tg-spoiler>тайна</tg-spoiler></i>');
    expect(markdownToTelegramHtml('_используй `/summary` и `/debts`_')).toBe(
      '<i>используй <code>/summary</code> и <code>/debts</code></i>',
    );
    expect(markdownToTelegramHtml('_текст <b>важно</b> конец_')).toBe(
      '<i>текст <b>важно</b> конец</i>',
    );
    expect(markdownToTelegramHtml('_проверь base_currency в настройках_')).toBe(
      '<i>проверь base_currency в настройках</i>',
    );
    expect(markdownToTelegramHtml('base_currency и max_tokens')).toBe('base_currency и max_tokens');
  });
});

describe('findProtectedSpans', () => {
  it('находит pre, code, спойлер и blockquote', () => {
    const text = '<pre>a</pre> <code>b</code> <tg-spoiler>c</tg-spoiler> <blockquote>d</blockquote>';
    const spans = findProtectedSpans(text);
    expect(spans).toHaveLength(4);
    expect(text.slice(spans[0]![0], spans[0]![1])).toBe('<pre>a</pre>');
  });
});

describe('splitMessageChunks', () => {
  it('короткий текст — один чанк', () => {
    expect(splitMessageChunks('привет')).toEqual(['привет']);
  });

  it('режет по абзацам и не теряет текст', () => {
    const paragraph = 'а'.repeat(60);
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const chunks = splitMessageChunks(text, 100);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
    expect(chunks.join('\n\n')).toBe(text);
  });

  // Защищённые спэны — это уже готовый Telegram HTML (`<pre>`, `<blockquote>`,
  // `<tg-spoiler>`), как в upstream: `split_message_chunks` вызывается после
  // `markdown_to_telegram_html`.
  it('не разрывает код-блок, если его можно вынести целиком', () => {
    const code = `<pre><code>${'x'.repeat(40)}</code></pre>`;
    const text = `${'п'.repeat(70)} ${code}`;
    const chunks = splitMessageChunks(text, 100);

    const withCode = chunks.filter((chunk) => chunk.includes('<pre>'));
    expect(withCode).toHaveLength(1);
    expect(withCode[0]).toBe(code);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain('п');
  });

  it('целевая длина по умолчанию — 3800', () => {
    expect(TARGET_CHUNK_LENGTH).toBe(3800);
  });
});

describe('safeSendMessage', () => {
  it('шлёт с HTML и цепляет клавиатуру только к последнему чанку', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const send = async (params: Record<string, unknown>): Promise<unknown> => {
      calls.push(params);
      return { message_id: calls.length };
    };

    await safeSendMessage(1, '**a**', {
      send,
      replyMarkup: { inline_keyboard: [] },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ chat_id: 1, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
    expect(calls[0]?.text).toBe('<b>a</b>');
  });

  it('isHtml=true не конвертирует разметку повторно', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await safeSendMessage(1, '<b>уже html</b>', {
      isHtml: true,
      send: async (params) => {
        calls.push(params);
        return { message_id: 1 };
      },
    });
    expect(calls[0]?.text).toBe('<b>уже html</b>');
  });

  it('429 повторяется сразу, без сна', async () => {
    let attempts = 0;
    const send = async (): Promise<unknown> => {
      attempts += 1;
      if (attempts === 1) throw apiError('sendMessage', 429, 'Too Many Requests: retry after 3');
      return { message_id: 7 };
    };

    const result = await safeSendMessage(1, 'текст', { send });

    expect(attempts).toBe(2);
    expect(result).toMatchObject({ message_id: 7 });
  });

  it('400 про сущности — фолбэк plain text без parse_mode', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const send = async (params: Record<string, unknown>): Promise<unknown> => {
      calls.push(params);
      if (params.parse_mode) {
        throw apiError('sendMessage', 400, "Bad Request: can't parse entities: unsupported start tag");
      }
      return { message_id: 3 };
    };

    await safeSendMessage(1, '**плохо**', { send });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ parse_mode: 'HTML', text: '<b>плохо</b>' });
    expect(calls[1]?.parse_mode).toBeUndefined();
    expect(calls[1]?.text).toBe('**плохо**');
  });

  it('прочие ошибки Bot API не ретраятся и не пробрасываются', async () => {
    let attempts = 0;
    const send = async (): Promise<unknown> => {
      attempts += 1;
      throw apiError('sendMessage', 403, 'Forbidden: bot was blocked by the user');
    };

    await expect(safeSendMessage(1, 'x', { send })).resolves.toBeNull();
    expect(attempts).toBe(1);
  });

  it('safeAnswer — алиас отправки', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await safeAnswer(2, 'x', {
      send: async (params) => {
        calls.push(params);
        return { message_id: 1 };
      },
    });
    expect(calls[0]?.chat_id).toBe(2);
  });
});

describe('safeEdit', () => {
  it('редактирует с HTML и прикладывает клавиатуру', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await safeEdit(1, 5, '**новое**', {
      replyMarkup: { inline_keyboard: [] },
      send: async (params) => {
        calls.push(params);
        return { message_id: 5 };
      },
    });

    expect(calls[0]).toMatchObject({
      chat_id: 1,
      message_id: 5,
      parse_mode: 'HTML',
      text: '<b>новое</b>',
      reply_markup: { inline_keyboard: [] },
    });
  });

  it('message is not modified — не ошибка, возвращает null', async () => {
    const send = async (): Promise<unknown> => {
      throw apiError('editMessageText', 400, 'Bad Request: message is not modified');
    };

    await expect(safeEdit(1, 5, 'x', { send })).resolves.toBeNull();
  });

  it('429 — немедленный повтор', async () => {
    let attempts = 0;
    const send = async (): Promise<unknown> => {
      attempts += 1;
      if (attempts === 1) throw apiError('editMessageText', 429, 'Too Many Requests');
      return { message_id: 5 };
    };

    await expect(safeEdit(1, 5, 'x', { send })).resolves.toMatchObject({ message_id: 5 });
    expect(attempts).toBe(2);
  });

  it('400 про сущности — правка без parse_mode', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const send = async (params: Record<string, unknown>): Promise<unknown> => {
      calls.push(params);
      if (params.parse_mode) throw apiError('editMessageText', 400, "can't parse entities");
      return { message_id: 5 };
    };

    await safeEdit(1, 5, '**x**', { send });

    expect(calls.at(-1)).toMatchObject({ chat_id: 1, message_id: 5, text: '**x**' });
    expect(calls.at(-1)?.parse_mode).toBeUndefined();
  });

  it('прочие ошибки пробрасываются', async () => {
    const send = async (): Promise<unknown> => {
      throw apiError('editMessageText', 400, 'Bad Request: message to edit not found');
    };

    await expect(safeEdit(1, 5, 'x', { send })).rejects.toThrow('message to edit not found');
  });
});

/**
 * Чистые помощники форматирования: Markdown → Telegram HTML и нарезка чанков.
 *
 * Живут в `lib/`, а не в `handlers/`, потому что имена файлов в `handlers/`
 * платформа ограничивает типами апдейтов: `build.mjs` вшивает помощники
 * `handlers/` внутрь `handlers/message.js` и `handlers/callback_query.js` и не
 * выкладывает их отдельными модулями. Импорт из `lib/` (например,
 * `lib/reminders.ts`, который шлёт утреннюю сводку) в рантайме не разрешился бы.
 *
 * Здесь только чистые функции: ни `sdk`, ни Bot API. `handlers/formatting.ts`
 * ре-экспортирует всё отсюда, поэтому остальные потребители (`router.ts`,
 * `ingest.ts`, тесты) импортируют по-прежнему из него.
 */

/** Максимум символов в одном сообщении Telegram. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** Целевая длина чанка с запасом под закрытие/открытие HTML-тегов. */
export const TARGET_CHUNK_LENGTH = 3800;

/**
 * Блоки, внутри которых резать сообщение нежелательно.
 * Группа 1 — `<pre|code|tg-spoiler>…</…>`; группа 2 — `<blockquote[ expandable]>…</blockquote>`.
 */
export const PROTECTED_SPLIT_TAGS_PATTERN =
  /<(pre|code|tg-spoiler)>([\s\S]*?)<\/\1>|<blockquote(?:\s+expandable)?>([\s\S]*?)<\/blockquote>/gi;

// ---------------------------------------------------------------------------
// Базовые помощники
// ---------------------------------------------------------------------------

/**
 * `html.escape(text, quote=False)`: только `&`, `<`, `>` (кавычки не трогаем).
 * Порядок важен — `&` первым, иначе экранируем собственные сущности.
 */
export function escapeAmpLtGt(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Безопасно обрезает текст для превью в цитате.
 * Длиннее `maxChars` — первые `maxChars` символов + пометка, что текст сохранён.
 */
export function formatQuotePreview(text: string, maxChars = 500): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  const totalLength = clean.length;
  const preview = clean.slice(0, maxChars).replace(/\s+$/u, '');
  return `${preview}... [всего ${totalLength} символов, сохранено в Инбокс]`;
}

/** Похоже на число или валюту (для выравнивания колонок). */
export function isNumericOrCurrency(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  const first = v[0] ?? '';
  if (/\p{Nd}/u.test(first) || /^[~+\-$€£¥₸₽]/.test(v)) return true;
  return /(%|€|\$|£|¥|₽|₸|EUR|USD|RUB|KZT|eur|usd|rub|kzt)$/.test(v);
}

/**
 * Колонка числовая, если все непустые значения — числа/валюты или нейтральные
 * заглушки (`-`, `N/A`, `?`) и хотя бы одно значение действительно числовое.
 */
export function isNumericColumn(values: readonly string[]): boolean {
  const nonEmpty = values.map((value) => value.trim()).filter((value) => value !== '');
  if (nonEmpty.length === 0) return false;

  const neutral = new Set(['-', '—', '–', 'N/A', 'n/a', 'NA', 'na', '?']);
  let hasNum = false;
  for (const value of nonEmpty) {
    if (neutral.has(value)) continue;
    if (isNumericOrCurrency(value)) {
      hasNum = true;
    } else {
      return false;
    }
  }
  return hasNum;
}

/**
 * Обрезает содержимое ячейки до `maxWidth`, добавляя `…`.
 * Как в upstream — без `trimEnd` перед многоточием.
 */
export function truncateCell(text: string, maxWidth: number): string {
  const s = text.trim();
  if (s.length > maxWidth) {
    if (maxWidth > 1) return `${s.slice(0, maxWidth - 1)}…`;
    return s.slice(0, maxWidth);
  }
  return s;
}

/** Строка таблицы как пропорциональные пункты: `• <b>{col1}</b>: {col2} · {col3}`. */
export function renderProportionalTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  void headers;
  const lines: string[] = [];
  for (const row of rows) {
    const cleanedCells = row.map((cell) => cleanTableCell(cell)).filter((cell) => cell !== '');
    if (cleanedCells.length === 0) continue;
    const first = escapeAmpLtGt(cleanedCells[0] as string);
    const rest = cleanedCells.slice(1).map((cell) => escapeAmpLtGt(cell));
    if (rest.length > 0) {
      lines.push(`• <b>${first}</b>: ${rest.join(' · ')}`);
    } else {
      lines.push(`• <b>${first}</b>`);
    }
  }
  return lines.join('\n');
}

/** Устаревший интерфейс, сохранённый для совместимости: тот же пропорциональный вывод. */
export function renderAsciiTable(
  headers: readonly string[] | null = null,
  rows: readonly (readonly string[])[] | null = null,
): string {
  if (!rows) return '';
  return renderProportionalTable(headers ?? [], rows);
}

/** Строка разделителя GFM-таблицы (`|---|---|`, `:--- | ---:`). */
export function isTableDelimiterRow(line: string): boolean {
  let stripped = line.trim();
  if (!stripped || !stripped.includes('|')) return false;
  if (stripped.startsWith('|')) stripped = stripped.slice(1);
  if (stripped.endsWith('|')) stripped = stripped.slice(0, -1);

  const parts = stripped.split('|');
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (!/^:?-+:?$/.test(part.trim())) return false;
  }
  return true;
}

/** Разбивает строку таблицы по `|` и обрезает пробелы у ячеек. */
export function splitTableRow(line: string): string[] {
  let stripped = line.trim();
  if (stripped.startsWith('|')) stripped = stripped.slice(1);
  if (stripped.endsWith('|')) stripped = stripped.slice(0, -1);
  return stripped.split('|').map((cell) => cell.trim());
}

/** Снимает Markdown-маркеры (`*`, `_`, `` ` ``) внутри ячейки таблицы. */
export function cleanTableCell(cell: string): string {
  let c = cell.trim();
  c = c.replace(/\*{1,3}([\s\S]*?)\*{1,3}/g, '$1');
  c = c.replace(/_{1,3}([\s\S]*?)_{1,3}/g, '$1');
  c = c.replace(/`([^`]+)`/g, '$1');
  return c.trim();
}

/**
 * Строка «пайп-таблицы»: начинается с `|` (после `trim`) и содержит минимум две
 * ячейки. Нужна для таблиц, написанных без строки-разделителя (`| :--- |`):
 * модель иногда её опускает, и трубы уходили в чат как есть.
 */
function isPipedTableRow(line: string): boolean {
  if (!line.trim().startsWith('|')) return false;
  return splitTableRow(line).length >= 2;
}

// ---------------------------------------------------------------------------
// Markdown → Telegram HTML
// ---------------------------------------------------------------------------

/** Регэкспы конвейера вынесены: их удобно читать и проверять в тестах. */
const CODE_BLOCK_RE = /```([\p{L}\p{N}_]+)?\n?([\s\S]*?)```/gu;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const SPOILER_RE = /\|\|([\s\S]+?)\|\|/g;
const EXPLICIT_EXPANDABLE_RE = />!\s*([\s\S]*?)\s*!</g;
const TELEGRAM_TAG_RE =
  /<\/?(?:b|strong|i|em|u|ins|s|strike|del|span|tg-spoiler|blockquote(?:\s+expandable)?|a(?:\s+href="[^"]*")?|code|pre)>/gi;
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const HEADER_RE = /^(#{1,6})\s+(.+)$/gm;
const HORIZONTAL_RULE_RE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm;
const CHECKBOX_EMPTY_RE = /^[ \t]*[*\-+][ \t]+\[ \][ \t]+/gm;
const CHECKBOX_DONE_RE = /^[ \t]*[*\-+][ \t]+\[[xX]\][ \t]+/gm;
const BULLET_RE = /^[ \t]*[*\-+][ \t]+/gm;

const QUOTE_CHECKBOX_EMPTY_RE = /^[ \t]*[*\-+][ \t]+\[ \][ \t]+/;
const QUOTE_CHECKBOX_DONE_RE = /^[ \t]*[*\-+][ \t]+\[[xX]\][ \t]+/;
const QUOTE_BULLET_RE = /^[ \t]*[*\-+][ \t]+/;
const QUOTE_MARKER_RE = /^[ \t]*>[ \t]?/;

/** Склеивает линии цитаты в `<blockquote>` (или `<blockquote expandable>`). */
function convertQuotes(blockText: string): string {
  const regularLines: string[] = [];
  let quoteLines: string[] = [];
  let inQuote = false;
  let isExpandable = false;

  const cleanQuoteLine = (line: string): string => {
    let clean = line.replace(QUOTE_CHECKBOX_EMPTY_RE, '☐ ');
    clean = clean.replace(QUOTE_CHECKBOX_DONE_RE, '✅ ');
    return clean.replace(QUOTE_BULLET_RE, '• ');
  };

  const flushQuote = (): void => {
    if (quoteLines.length === 0) return;
    const tag = isExpandable || quoteLines.length >= 4 ? '<blockquote expandable>' : '<blockquote>';
    regularLines.push(`${tag}${quoteLines.map(cleanQuoteLine).join('\n')}</blockquote>`);
    quoteLines = [];
    isExpandable = false;
  };

  for (const line of blockText.split('\n')) {
    if (line.startsWith('&gt;!')) {
      quoteLines.push(
        line
          .replace(/^&gt;!\s?/, '')
          .replace(/!&lt;$/, '')
          .replace(/!<$/, '')
          .trim(),
      );
      inQuote = true;
      isExpandable = true;
    } else if (line.startsWith('&gt;')) {
      quoteLines.push(
        line
          .replace(/^&gt;\s?/, '')
          .replace(/!&lt;$/, '')
          .replace(/!<$/, '')
          .trim(),
      );
      inQuote = true;
    } else {
      if (inQuote) {
        flushQuote();
        inQuote = false;
      }
      regularLines.push(line);
    }
  }

  if (inQuote) flushQuote();
  return regularLines.join('\n');
}

/**
 * Конвертирует Markdown (LLM-style) в HTML, разрешённый Telegram.
 * Шаги и их порядок повторяют `markdown_to_telegram_html` из upstream.
 */
export function markdownToTelegramHtml(text: string): string {
  if (!text) return '';

  let out = text.replace(/\r\n/g, '\n');

  // 1. Код-блоки прячем в плейсхолдеры (внутри они уже экранированы).
  //    В именах плейсхолдеров нет `_`, чтобы не рвать курсив `_…_`.
  const codeBlocks: string[] = [];
  out = out.replace(CODE_BLOCK_RE, (match, langRaw: string | undefined, codeRaw: string) => {
    const lang = langRaw ?? '';
    const index = codeBlocks.length;
    const escapedCode = escapeAmpLtGt(codeRaw.replace(/^\n+/, '').replace(/\n+$/, ''));
    codeBlocks.push(
      lang
        ? `<pre><code class="language-${lang}">${escapedCode}</code></pre>`
        : `<pre><code>${escapedCode}</code></pre>`,
    );
    void match;
    return `@@@CODEBLOCK${index}@@@`;
  });

  // 2. GFM-таблицы → пропорциональные пункты (тоже в code_blocks — это готовый HTML).
  //    Разделитель (`| :--- |`) необязателен: блок из двух и более строк, каждая
  //    из которых начинается с `|` и имеет ≥2 ячеек, тоже считается таблицей.
  const lines = out.split('\n');
  const newLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const headerLine = lines[i] as string;
    const nextLine = i + 1 < lines.length ? (lines[i + 1] as string) : null;
    if (nextLine !== null && isTableDelimiterRow(nextLine) && headerLine.includes('|')) {
      const headers = splitTableRow(headerLine).map((cell) => cleanTableCell(cell));
      let rowIndex = i + 2;
      const rows: string[][] = [];
      while (rowIndex < lines.length) {
        const line = lines[rowIndex] as string;
        if (!line.trim() || !line.includes('|') || isTableDelimiterRow(line)) break;
        rows.push(splitTableRow(line).map((cell) => cleanTableCell(cell)));
        rowIndex += 1;
      }
      const tableHtml = renderAsciiTable(headers, rows);
      const index = codeBlocks.length;
      codeBlocks.push(tableHtml);
      newLines.push(`@@@CODEBLOCK${index}@@@`);
      i = rowIndex;
    } else if (isPipedTableRow(headerLine)) {
      // Разделителя нет: первая строка — заголовок, отбрасываем его так же,
      // как строку разделителя, чтобы остался список строк данных.
      const headers = splitTableRow(headerLine).map((cell) => cleanTableCell(cell));
      let rowIndex = i + 1;
      const rows: string[][] = [];
      while (rowIndex < lines.length) {
        const line = lines[rowIndex] as string;
        if (!isPipedTableRow(line) || isTableDelimiterRow(line)) break;
        rows.push(splitTableRow(line).map((cell) => cleanTableCell(cell)));
        rowIndex += 1;
      }
      if (rows.length === 0) {
        // Одиночная строка с трубами — не таблица, оставляем как есть.
        newLines.push(headerLine);
        i += 1;
      } else {
        const tableHtml = renderAsciiTable(headers, rows);
        const index = codeBlocks.length;
        codeBlocks.push(tableHtml);
        newLines.push(`@@@CODEBLOCK${index}@@@`);
        i = rowIndex;
      }
    } else {
      newLines.push(headerLine);
      i += 1;
    }
  }
  out = newLines.join('\n');

  // 3. Инлайн-код.
  const inlineCodes: string[] = [];
  out = out.replace(INLINE_CODE_RE, (match, code: string) => {
    const index = inlineCodes.length;
    inlineCodes.push(`<code>${escapeAmpLtGt(code)}</code>`);
    void match;
    return `@@@INLINECODE${index}@@@`;
  });

  // 4. Спойлеры: ||text|| → <tg-spoiler>.
  out = out.replace(SPOILER_RE, '<tg-spoiler>$1</tg-spoiler>');

  // 5. Явные раскрывающиеся цитаты: >! … !<.
  out = out.replace(EXPLICIT_EXPANDABLE_RE, (_match, content: string) => {
    const cleanedLines = content
      .trim()
      .split('\n')
      .map((line) => line.replace(QUOTE_MARKER_RE, ''));
    const converted = cleanedLines.map((line) => {
      let c = line.replace(QUOTE_CHECKBOX_EMPTY_RE, '☐ ');
      c = c.replace(QUOTE_CHECKBOX_DONE_RE, '✅ ');
      return c.replace(QUOTE_BULLET_RE, '• ');
    });
    return `<blockquote expandable>${converted.join('\n')}</blockquote>`;
  });

  // 6. Уже валидные Telegram-теги (включая только что созданные) — в плейсхолдеры.
  const telegramTags: string[] = [];
  out = out.replace(TELEGRAM_TAG_RE, (match) => {
    const index = telegramTags.length;
    telegramTags.push(match);
    return `@@@TGTAG${index}@@@`;
  });

  // 7. Экранирование остального текста.
  out = escapeAmpLtGt(out);

  // 8. Ссылки: [text](url) → <a href="url">text</a>.
  out = out.replace(LINK_RE, (_match, label: string, url: string) => `<a href="${url}">${label}</a>`);

  // 9. Заголовки: # H1 → <b>H1</b>.
  out = out.replace(HEADER_RE, (_match, _hashes: string, title: string) => `<b>${title}</b>`);

  // 10. Горизонтальные линии.
  out = out.replace(HORIZONTAL_RULE_RE, '───────────────');

  // 11. Чекбоксы задач.
  out = out.replace(CHECKBOX_EMPTY_RE, '☐ ');
  out = out.replace(CHECKBOX_DONE_RE, '✅ ');

  // 12. Маркированные списки.
  out = out.replace(BULLET_RE, '• ');

  // 13. Цитаты: `>` уже стал `&gt;`; 4+ строки — раскрывающиеся.
  out = convertQuotes(out);

  // 14. Жирный курсив.
  out = out.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<b><i>$1</i></b>');
  out = out.replace(/___([\s\S]+?)___/g, '<b><i>$1</i></b>');

  // 15. Жирный.
  out = out.replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>');
  out = out.replace(/__([\s\S]+?)__/g, '<b>$1</b>');

  // 16. Зачёркнутый.
  out = out.replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');

  // 17. Курсив — не трогая snake_case и уже собранные теги.
  out = out.replace(/(?<![\p{L}\p{N}_*])\*([^*\n]+?)\*(?![\p{L}\p{N}_*])/gu, '<i>$1</i>');
  out = out.replace(
    /(?<![\p{L}\p{N}_])_((?:[^_\n]|(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}]))+?)_(?![\p{L}\p{N}_])/gu,
    '<i>$1</i>',
  );

  // 18. Возвращаем теги, инлайн-код и код-блоки.
  telegramTags.forEach((tag, index) => {
    out = out.split(`@@@TGTAG${index}@@@`).join(tag);
  });
  inlineCodes.forEach((snippet, index) => {
    out = out.split(`@@@INLINECODE${index}@@@`).join(snippet);
  });
  codeBlocks.forEach((snippet, index) => {
    out = out.split(`@@@CODEBLOCK${index}@@@`).join(snippet);
  });

  return out;
}

// ---------------------------------------------------------------------------
// Нарезка длинных сообщений
// ---------------------------------------------------------------------------

/** Интервалы защищённых блоков в строке. */
export function findProtectedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const pattern = new RegExp(PROTECTED_SPLIT_TAGS_PATTERN.source, PROTECTED_SPLIT_TAGS_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    spans.push([match.index, match.index + match[0].length]);
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return spans;
}

/** `rfind(sub, 0, limit)`: стартовая позиция последнего вхождения, целиком лежащего в `[0, limit)`. */
function rfindBelow(text: string, sub: string, limit: number): number {
  if (limit < sub.length) return -1;
  const found = text.lastIndexOf(sub, limit - sub.length);
  return found < 0 ? -1 : found;
}

/**
 * Режет текст на чанки не длиннее `maxLength`, предпочитая границы абзаца,
 * строки или пробела; внутри `<pre>/<blockquote>/<tg-spoiler>` не режет,
 * если можно вынести блок целиком.
 */
export function splitMessageChunks(text: string, maxLength = TARGET_CHUNK_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const spans = findProtectedSpans(remaining);
    const enclosingSpan = (position: number): [number, number] | null => {
      for (const span of spans) {
        if (span[0] < position && position < span[1]) return span;
      }
      return null;
    };

    let splitPoint = -1;
    let limit = maxLength;

    while (limit > 0) {
      let sp = rfindBelow(remaining, '\n\n', limit);
      if (sp === -1) sp = rfindBelow(remaining, '\n', limit);
      if (sp === -1) sp = rfindBelow(remaining, ' ', limit);
      if (sp === -1) break;

      const enclosing = enclosingSpan(sp);
      if (enclosing === null) {
        splitPoint = sp;
        break;
      }
      if (enclosing[0] > 0) {
        limit = enclosing[0];
      } else {
        splitPoint = sp;
        break;
      }
    }

    if (splitPoint === -1 || splitPoint === 0) {
      const enclosing = enclosingSpan(maxLength);
      if (enclosing && enclosing[0] > 0) {
        splitPoint = enclosing[0];
      } else {
        splitPoint = maxLength;
      }
    }

    const chunk = remaining.slice(0, splitPoint).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitPoint).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks.filter((chunk) => chunk !== '');
}

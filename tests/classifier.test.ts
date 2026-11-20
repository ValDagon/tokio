/**
 * Классификатор инбокса (`src/lib/classifier.ts`).
 *
 * Модель подменяется моком через `setClassifierChat()` — ни сети, ни ключей.
 * Проверяем главное, что легко сломать при правках:
 *  1) разбор «грязного» ответа (фенсы, болтовня вокруг JSON, битый JSON);
 *  2) fallback: сообщение никогда не теряется и не бросает;
 *  3) нормализацию полей по правилам Python (категории, теги, meta, заголовок);
 *  4) форму запроса к LLM (json_object, temperature, purpose, контекст).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLASSIFIER_SYSTEM_PROMPT,
  FALLBACK_TITLE,
  MAX_TITLE_LENGTH,
  buildClassifierUserPrompt,
  buildInboxFallback,
  isInboxCategory,
  normalizeClassifierPayload,
  normalizeInboxMessage,
  parseClassifierJson,
  setClassifierChat,
} from '../src/lib/classifier';
import type { ClassifierChatFn } from '../src/lib/classifier';

const VALID_JSON = JSON.stringify({
  category: 'expense',
  clean_title: 'Оплатить интернет',
  clean_text: 'Оплатить интернет до пятницы',
  tags: ['дом', 'платежи'],
  actionable: true,
  extracted_meta: { amount: 45.5, currency: 'EUR', due_date: '2026-11-10' },
});

beforeEach(() => {
  setClassifierChat(null);
});

afterEach(() => {
  setClassifierChat(null);
});

describe('parseClassifierJson', () => {
  it('читает чистый JSON', () => {
    expect(parseClassifierJson('{"category":"task"}')).toEqual({ category: 'task' });
  });

  it('снимает markdown-фенс', () => {
    const wrapped = `Вот результат:\n\`\`\`json\n${VALID_JSON}\n\`\`\`\nГотово.`;
    expect(parseClassifierJson(wrapped)?.clean_title).toBe('Оплатить интернет');
  });

  it('вырезает объект из болтовни без фенсов', () => {
    expect(parseClassifierJson(`Конечно! ${VALID_JSON} Если нужно — уточню.`)?.category).toBe(
      'expense',
    );
  });

  it('возвращает null на битом JSON и не-объектах', () => {
    expect(parseClassifierJson('{"category": "task"')).toBeNull();
    expect(parseClassifierJson('совсем не json')).toBeNull();
    expect(parseClassifierJson('[1, 2, 3]')).toBeNull();
    expect(parseClassifierJson('')).toBeNull();
  });
});

describe('buildInboxFallback', () => {
  it('отдаёт сырой текст в категории thought', () => {
    const fallback = buildInboxFallback('  Купить лампу  ');
    expect(fallback.category).toBe('thought');
    expect(fallback.cleanTitle).toBe('Купить лампу');
    expect(fallback.cleanText).toBe('Купить лампу');
    expect(fallback.tags).toEqual(['raw']);
    expect(fallback.actionable).toBe(false);
    expect(fallback.extractedMeta).toEqual({});
  });

  it('подставляет «Заметка» на пустом тексте', () => {
    expect(buildInboxFallback('   ').cleanTitle).toBe(FALLBACK_TITLE);
  });

  it('режет длинный заголовок до 60 символов', () => {
    const fallback = buildInboxFallback(`${'а'.repeat(120)}`);
    expect(fallback.cleanTitle).toHaveLength(MAX_TITLE_LENGTH);
    expect(fallback.cleanTitle.endsWith('…')).toBe(true);
  });
});

describe('normalizeClassifierPayload', () => {
  it('приводит валидный ответ к доменной форме', () => {
    const result = normalizeClassifierPayload(JSON.parse(VALID_JSON), 'сырой текст');

    expect(result.category).toBe('expense');
    expect(result.cleanTitle).toBe('Оплатить интернет');
    expect(result.cleanText).toBe('Оплатить интернет до пятницы');
    expect(result.tags).toEqual(['дом', 'платежи']);
    expect(result.actionable).toBe(true);
    expect(result.extractedMeta).toEqual({
      amount: 45.5,
      currency: 'EUR',
      due_date: '2026-11-10',
    });
  });

  it('неизвестную категорию сводит к thought', () => {
    expect(normalizeClassifierPayload({ category: 'finance' }, 'текст').category).toBe('thought');
    expect(normalizeClassifierPayload({ category: 42 }, 'текст').category).toBe('thought');
  });

  it('не-массив тегов превращает в ["inbox"]', () => {
    expect(normalizeClassifierPayload({ tags: 'дом' }, 'текст').tags).toEqual(['inbox']);
    expect(normalizeClassifierPayload({}, 'текст').tags).toEqual(['inbox']);
  });

  it('чистит теги и выбрасывает пустые', () => {
    const result = normalizeClassifierPayload({ tags: ['  дом ', '', 7] }, 'текст');
    expect(result.tags).toEqual(['дом', '7']);
  });

  it('actionable считает только strict true', () => {
    expect(normalizeClassifierPayload({ actionable: true }, 'x').actionable).toBe(true);
    expect(normalizeClassifierPayload({ actionable: 'true' }, 'x').actionable).toBe(false);
  });

  it('достаёт сумму из строки и нормализует валюту', () => {
    const result = normalizeClassifierPayload(
      { extracted_meta: { amount: '1 234,56 €', currency: 'eur', shop: 'Corner Store' } },
      'x',
    );
    expect(result.extractedMeta.amount).toBe(1234.56);
    expect(result.extractedMeta.currency).toBe('EUR');
    expect(result.extractedMeta.due_date).toBeNull();
    // неизвестные ключи не теряются — они уезжают в metadata
    expect(result.extractedMeta.shop).toBe('Corner Store');
  });

  it('битые поля meta гасит в null', () => {
    const result = normalizeClassifierPayload(
      { extracted_meta: { amount: 'дорого', currency: 'евро', due_date: 12 } },
      'x',
    );
    expect(result.extractedMeta.amount).toBeNull();
    expect(result.extractedMeta.currency).toBeNull();
    expect(result.extractedMeta.due_date).toBeNull();
  });

  it('пустой clean_text заменяет сырым текстом', () => {
    const result = normalizeClassifierPayload({ clean_text: '   ' }, '  Сырой текст  ');
    expect(result.cleanText).toBe('Сырой текст');
  });

  it('не-объект в meta → пустой объект', () => {
    expect(normalizeClassifierPayload({ extracted_meta: 'нет' }, 'x').extractedMeta).toEqual({});
    expect(normalizeClassifierPayload({ extracted_meta: [1] }, 'x').extractedMeta).toEqual({});
  });

  it('заголовок режется до 60 символов', () => {
    const result = normalizeClassifierPayload({ clean_title: 'б'.repeat(100) }, 'x');
    expect(result.cleanTitle).toHaveLength(MAX_TITLE_LENGTH);
  });
});

describe('normalizeInboxMessage', () => {
  it('вызывает модель в JSON-режиме и разбирает ответ', async () => {
    const chat = vi.fn<ClassifierChatFn>(async () => VALID_JSON);
    setClassifierChat(chat);

    const result = await normalizeInboxMessage('Оплатить интернет в пятницу', { userId: 42 });

    expect(result.category).toBe('expense');
    expect(result.cleanTitle).toBe('Оплатить интернет');
    expect(chat).toHaveBeenCalledTimes(1);

    const request = chat.mock.calls[0][0];
    expect(request.systemPrompt).toBe(CLASSIFIER_SYSTEM_PROMPT);
    expect(request.userPrompt).toContain('Оплатить интернет в пятницу');
    expect(request.responseFormat).toBe('json_object');
    expect(request.temperature).toBe(0.1);
    expect(request.purpose).toBe('inbox_normalization');
    expect(request.userId).toBe(42);
  });

  it('передаёт контекст в промпт', async () => {
    const chat = vi.fn<ClassifierChatFn>(async () => VALID_JSON);
    setClassifierChat(chat);

    await normalizeInboxMessage('и ещё вот это', { context: 'обсуждали бюджет' });
    expect(chat.mock.calls[0][0].userPrompt).toBe(
      'Контекст: обсуждали бюджет\nВходящее сообщение: «и ещё вот это»',
    );
  });

  it('разбирает ответ в markdown-фенсе', async () => {
    setClassifierChat(async () => `\`\`\`json\n${VALID_JSON}\n\`\`\``);
    const result = await normalizeInboxMessage('текст');
    expect(result.category).toBe('expense');
    expect(result.actionable).toBe(true);
  });

  it('на битом JSON отдаёт fallback и не бросает', async () => {
    setClassifierChat(async () => '{"category": "ta');
    const result = await normalizeInboxMessage('  Сырая заметка  ');
    expect(result).toEqual(buildInboxFallback('  Сырая заметка  '));
  });

  it('на исключении модели отдаёт fallback', async () => {
    setClassifierChat(async () => {
      throw new Error('quota exceeded');
    });
    const result = await normalizeInboxMessage('Не потеряй меня');
    expect(result.category).toBe('thought');
    expect(result.cleanText).toBe('Не потеряй меня');
  });

  it('без подключённой модели отдаёт fallback', async () => {
    setClassifierChat(null);
    const result = await normalizeInboxMessage('Заметка без модели');
    expect(result.cleanTitle).toBe('Заметка без модели');
    expect(result.tags).toEqual(['raw']);
  });

  it('на пустом тексте не зовёт модель', async () => {
    const chat = vi.fn<ClassifierChatFn>(async () => VALID_JSON);
    setClassifierChat(chat);

    const result = await normalizeInboxMessage('   ');
    expect(chat).not.toHaveBeenCalled();
    expect(result.cleanTitle).toBe(FALLBACK_TITLE);
    expect(result.cleanText).toBe('');
  });
});

describe('мелочи', () => {
  it('isInboxCategory узнаёт только известные категории', () => {
    expect(isInboxCategory('medical')).toBe(true);
    expect(isInboxCategory('Medical')).toBe(false);
    expect(isInboxCategory('finance')).toBe(false);
    expect(isInboxCategory(undefined)).toBe(false);
  });

  it('buildClassifierUserPrompt без контекста не добавляет префикс', () => {
    expect(buildClassifierUserPrompt('привет')).toBe('Входящее сообщение: «привет»');
    expect(buildClassifierUserPrompt('привет', '   ')).toBe('Входящее сообщение: «привет»');
  });
});

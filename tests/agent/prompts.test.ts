/**
 * Системный промпт агента (`src/lib/agent/prompts.ts`).
 *
 * Что проверяем (SPEC §3 T11, ADR-002):
 *  1) дата и время в промпте считаются в таймзоне пользователя и в русском
 *     формате upstream (`2026-11-06 (пятница, 6 ноября 2026 г.)`);
 *  2) режимы: без режима — все три секции, с режимом — одна и с пометкой
 *     «АКТИВНЫЙ РЕЖИМ»;
 *  3) персонализация приходит только параметрами (имя, валюта, стиль, личные
 *     директивы) и не подмешивается, если её нет;
 *  4) каталог тулз рендерится из реестра, пустой каталог честно говорит, что
 *     инструментов нет;
 *  5) в тексте промпта нет персональных данных upstream-владельца (банки,
 *     город) — иначе ADR-002 нарушен и гард `tests/config.test.ts` упадёт.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSISTANT_NAME,
  buildSystemPrompt,
  computeWorkloadMetrics,
  detectMode,
  detectOverloadMarkers,
  evaluateExecutiveOverload,
  formatDateRu,
  localMoment,
  resolvePersonaStyle,
} from '../../src/lib/agent/prompts';
import type { ToolSummary } from '../../src/lib/agent/registry';

/** Пятница, 6 ноября 2026 — фиксированный момент для всех проверок даты. */
const NOW = new Date('2026-11-06T09:30:00Z');

describe('дата и время', () => {
  it('форматирует дату как upstream и считает её в таймзоне пользователя', () => {
    expect(formatDateRu(NOW, 'UTC')).toBe('2026-11-06 (пятница, 6 ноября 2026 г.)');
    // UTC+3: тот же календарный день, но местное время сдвинуто.
    expect(localMoment(NOW, 'Europe/Moscow').time).toBe('12:30');
    expect(formatDateRu(NOW, 'Europe/Moscow')).toBe('2026-11-06 (пятница, 6 ноября 2026 г.)');
  });

  it('попадает в промпт вместе с таймзоной пользователя', () => {
    const prompt = buildSystemPrompt({
      now: NOW,
      profile: { timezone: 'UTC' },
    });

    expect(prompt).toContain('ТЕКУЩЕЕ ВРЕМЯ И КАЛЕНДАРЬ:');
    expect(prompt).toContain('Сегодняшняя дата: 2026-11-06 (пятница, 6 ноября 2026 г.)');
    expect(prompt).toContain('Местное время пользователя: 09:30 (UTC)');
  });

  it('невалидная или пробельная таймзона безопасно откатывается на UTC без пустых скобок', () => {
    const invalidPrompt = buildSystemPrompt({
      now: NOW,
      profile: { timezone: 'Invalid/Zone' },
    });
    expect(invalidPrompt).toContain('Сегодняшняя дата: 2026-11-06 (пятница, 6 ноября 2026 г.)');
    expect(invalidPrompt).toContain('Местное время пользователя: 09:30 (UTC)');
    expect(invalidPrompt).not.toContain('Invalid/Zone');

    const blankPrompt = buildSystemPrompt({
      now: NOW,
      profile: { timezone: '   ' },
    });
    expect(blankPrompt).toContain('Местное время пользователя: 09:30 (UTC)');
    expect(blankPrompt).not.toContain('()');
  });

  it('держит стабильный побайтовый префикс до финального блока даты (prompt cache)', () => {
    const tools: ToolSummary[] = [
      {
        name: 'list_tasks',
        description: 'Список задач.',
        schema: { type: 'object', properties: {} },
      },
    ];
    const shared = {
      mode: 'action' as const,
      tools,
      maxSteps: 8,
      profile: {
        userName: 'Тестовый Пользователь',
        timezone: 'UTC',
        baseCurrency: 'EUR',
        personaStyle: 'mentor' as const,
        customInstructions: 'Отвечай кратко.',
      },
    };
    const promptA = buildSystemPrompt({ ...shared, now: new Date('2026-11-18T10:01:00Z') });
    const promptB = buildSystemPrompt({ ...shared, now: new Date('2026-11-18T10:45:00Z') });

    const marker = 'ТЕКУЩЕЕ ВРЕМЯ И КАЛЕНДАРЬ:';
    const idxA = promptA.indexOf(marker);
    const idxB = promptB.indexOf(marker);
    expect(idxA).toBeGreaterThan(0);
    expect(idxA).toBe(idxB);
    expect(promptA.slice(0, idxA)).toBe(promptB.slice(0, idxB));
    expect(promptA.slice(idxA)).not.toBe(promptB.slice(idxB));

    // Блок даты — самый последний в промпте (после кастомных директив).
    const customIdx = promptA.indexOf('ВЫСШИЕ ПОЛЬЗОВАТЕЛЬСКИЕ ДИРЕКТИВЫ');
    expect(customIdx).toBeGreaterThan(0);
    expect(idxA).toBeGreaterThan(customIdx);
    expect(promptA.endsWith('Местное время пользователя: 10:01 (UTC)')).toBe(true);
    expect(promptB.endsWith('Местное время пользователя: 10:45 (UTC)')).toBe(true);
  });
});

describe('режимы', () => {
  it('без режима описывает все три режима и не выбирает активный', () => {
    const prompt = buildSystemPrompt({ now: NOW });

    expect(prompt).toContain('ТРИ РЕЖИМА РАБОТЫ:');
    expect(prompt).toContain('РЕЖИМ БЫСТРОГО ДЕЙСТВИЯ');
    expect(prompt).toContain('РЕЖИМ МЫСЛИТЕЛЬНОГО ПАРТНЁРА');
    expect(prompt).toContain('РЕЖИМ ЭКСПЕРТА ПО СИСТЕМЕ');
    expect(prompt).not.toContain('АКТИВНЫЙ РЕЖИМ:');
  });

  it('с режимом оставляет одну секцию и помечает её активной', () => {
    const prompt = buildSystemPrompt({ now: NOW, mode: 'system_expert' });

    expect(prompt).toContain('АКТИВНЫЙ РЕЖИМ:');
    expect(prompt).toContain('РЕЖИМ ЭКСПЕРТА ПО СИСТЕМЕ');
    expect(prompt).not.toContain('ТРИ РЕЖИМА РАБОТЫ:');
    expect(prompt).not.toContain('РЕЖИМ МЫСЛИТЕЛЬНОГО ПАРТНЁРА');
  });

  it('подставляет лимит шагов, о котором модель обязана знать', () => {
    const prompt = buildSystemPrompt({ now: NOW, maxSteps: 5 });
    expect(prompt).toContain('Максимум шагов в этом диалоге: 5.');
  });
});

describe('detectMode', () => {
  it('узнаёт вопросы об устройстве системы', () => {
    expect(detectMode('Как устроен бот и какие есть команды?')).toBe('system_expert');
    expect(detectMode('Покажи документацию по задачам')).toBe('system_expert');
  });

  it('узнаёт запросы на размышление и стратегию', () => {
    expect(detectMode('Как мне лучше поступить с проектами?')).toBe('thought_partner');
    expect(detectMode('Обсудим приоритеты на неделю')).toBe('thought_partner');
  });

  it('всё остальное — быстрое действие', () => {
    expect(detectMode('Запиши трату 12 евро на обед')).toBe('action');
    expect(detectMode('')).toBe('action');
    expect(detectMode(null)).toBe('action');
  });
});

describe('персонализация', () => {
  it('берёт имя, валюту, стиль и директивы из параметров', () => {
    const prompt = buildSystemPrompt({
      now: NOW,
      profile: {
        userName: 'Тестовый Пользователь',
        baseCurrency: 'USD',
        personaStyle: 'mentor',
        customInstructions: 'Отвечай только списками.',
      },
    });

    expect(prompt).toContain('Обращайся к пользователю по имени: Тестовый Пользователь.');
    expect(prompt).toContain('Базовая валюта пользователя: USD');
    expect(prompt).toContain('Стиль общения: Мудрый, поддерживающий наставник');
    expect(prompt).toContain('🎯 ВЫСШИЕ ПОЛЬЗОВАТЕЛЬСКИЕ ДИРЕКТИВЫ (CUSTOM INSTRUCTIONS):');
    expect(prompt).toContain('Отвечай только списками.');
  });

  it('не выдумывает персонализацию, когда данных нет', () => {
    const prompt = buildSystemPrompt({ now: NOW, profile: {} });

    expect(prompt).not.toContain('Обращайся к пользователю по имени:');
    expect(prompt).not.toContain('Базовая валюта пользователя:');
    expect(prompt).not.toContain('ТЕКУЩИЙ СТИЛЬ ОБЩЕНИЯ:');
    expect(prompt).not.toContain('ВЫСШИЕ ПОЛЬЗОВАТЕЛЬСКИЕ ДИРЕКТИВЫ');
    expect(prompt).toContain(`Ты — «${DEFAULT_ASSISTANT_NAME}»`);
  });
});

describe('resolvePersonaStyle', () => {
  it('знает четыре стиля и пропускает незнакомый текст как есть', () => {
    expect(resolvePersonaStyle('concise')).toContain('лаконичный');
    expect(resolvePersonaStyle('strategist')).toContain('Стратегический партнёр');
    expect(resolvePersonaStyle('Мой собственный стиль')).toBe('Мой собственный стиль');
    expect(resolvePersonaStyle(null)).toBeNull();
    expect(resolvePersonaStyle('   ')).toBeNull();
  });
});

describe('каталог инструментов', () => {
  const tools: ToolSummary[] = [
    {
      name: 'add_task',
      description: 'Добавить задачу в список.',
      schema: { type: 'object', properties: { title: { type: 'string' } } },
    },
  ];

  it('рендерит имена, описания и схему аргументов', () => {
    const prompt = buildSystemPrompt({ now: NOW, tools });

    expect(prompt).toContain('КАТАЛОГ ИНСТРУМЕНТОВ:');
    expect(prompt).toContain('- add_task: Добавить задачу в список.');
    expect(prompt).toContain('Аргументы: {"type":"object"');
  });

  it('без инструментов честно говорит, что их нет', () => {
    const prompt = buildSystemPrompt({ now: NOW, tools: [] });
    expect(prompt).toContain('Инструменты не подключены.');
  });

  it('обрезает раздутую схему, чтобы не раздувать промпт', () => {
    const huge: ToolSummary = {
      name: 'huge_tool',
      description: 'Инструмент с гигантской схемой.',
      schema: { type: 'object', description: 'x'.repeat(2000) },
    };
    const prompt = buildSystemPrompt({ now: NOW, tools: [huge] });
    const line = prompt.split('\n').find((row) => row.startsWith('  Аргументы:')) ?? '';

    expect(line).toContain('…');
    expect(line.length).toBeLessThan(720);
  });
});

describe('ADR-002: системный промпт нейтрален без персонального оверлея', () => {
  it('нейтрален без профиля и не содержит персональных/локальных маркеров', () => {
    const prompt = buildSystemPrompt({ now: NOW, tools: [] });

    expect(prompt).toContain('Tokio');
    expect(prompt).not.toMatch(/app\d{10}\.tgcloud\.ai/);
    expect(prompt).not.toMatch(/\/Users\/[a-zA-Z0-9._-]+\//);
    expect(prompt).not.toMatch(/\bF[24]\d\.\d\b/);
    expect(prompt).not.toMatch(/@gmail\.com/i);
    expect(prompt).not.toMatch(/Наличные|Фриланс|Поиск работы/i);
  });
});

describe('computeWorkloadMetrics', () => {
  it('считает активные задачи, просрочку по локальной дате и пропущенные дозы (+30 мин)', () => {
    const metrics = computeWorkloadMetrics(
      [
        { dueAt: '2026-11-05' },
        { dueAt: '2026-11-06T08:00:00Z' },
        { dueAt: '2026-11-06' },
        { dueAt: null },
      ],
      [
        { status: 'pending', scheduledTime: '09:00' },
        { status: 'pending', scheduledTime: '09:01' },
        { status: 'taken', scheduledTime: '08:00' },
      ],
      'UTC',
      NOW,
    );

    expect(metrics).toEqual({
      activeTodoCount: 4,
      overdueTaskCount: 1,
      missedMedsCount: 1,
    });
  });
});

describe('evaluateExecutiveOverload и overloadShieldBlock', () => {
  it('wipOverload: срабатывает при >= 3 просроченных или >= 12 активных задачах', () => {
    const below = evaluateExecutiveOverload({
      timezone: 'UTC',
      now: NOW,
      overdueTaskCount: 2,
      activeTodoCount: 11,
      missedMedsCount: 0,
    });
    expect(below.factors.wipOverload).toBe(false);
    expect(below.isOverloaded).toBe(false);

    const byOverdue = evaluateExecutiveOverload({
      timezone: 'UTC',
      now: NOW,
      overdueTaskCount: 3,
      activeTodoCount: 3,
    });
    expect(byOverdue.factors.wipOverload).toBe(true);
    expect(byOverdue.activeFactorCount).toBe(1);
    expect(byOverdue.isOverloaded).toBe(false);

    const byActive = evaluateExecutiveOverload({
      timezone: 'UTC',
      now: NOW,
      overdueTaskCount: 0,
      activeTodoCount: 12,
    });
    expect(byActive.factors.wipOverload).toBe(true);
    expect(byActive.activeFactorCount).toBe(1);
    expect(byActive.isOverloaded).toBe(false);
  });

  it('circadianOrTherapyLoad: считает локальный час в таймзоне пользователя без дрейфа в UTC и учитывает пропущенные дозы', () => {
    // 19:30Z летом: 21:30 в Europe/Berlin (CEST) и 22:30 в Europe/Moscow -> вечернее окно (>= 21).
    const summerEveningUtc = new Date('2026-07-15T19:30:00Z');
    const berlin = evaluateExecutiveOverload({
      timezone: 'Europe/Berlin',
      now: summerEveningUtc,
    });
    expect(berlin.localHour).toBe(21);
    expect(berlin.factors.circadianOrTherapyLoad).toBe(true);

    const moscow = evaluateExecutiveOverload({
      timezone: 'Europe/Moscow',
      now: new Date('2026-11-06T19:30:00Z'),
    });
    expect(moscow.localHour).toBe(22);
    expect(moscow.factors.circadianOrTherapyLoad).toBe(true);

    // 20:30Z в America/New_York: 15:30 днём -> не включает вечернее окно.
    const newYorkAfternoon = evaluateExecutiveOverload({
      timezone: 'America/New_York',
      now: new Date('2026-11-06T20:30:00Z'),
    });
    expect(newYorkAfternoon.localHour).toBe(15);
    expect(newYorkAfternoon.factors.circadianOrTherapyLoad).toBe(false);

    // Ночное окно (< 6): 05:30 MSK (02:30Z) -> true, 06:00 MSK (03:00Z) -> false.
    const moscowNight = evaluateExecutiveOverload({
      timezone: 'Europe/Moscow',
      now: new Date('2026-11-06T02:30:00Z'),
    });
    expect(moscowNight.localHour).toBe(5);
    expect(moscowNight.factors.circadianOrTherapyLoad).toBe(true);

    const moscowMorning = evaluateExecutiveOverload({
      timezone: 'Europe/Moscow',
      now: new Date('2026-11-06T03:00:00Z'),
    });
    expect(moscowMorning.localHour).toBe(6);
    expect(moscowMorning.factors.circadianOrTherapyLoad).toBe(false);

    // Пропущенный приём лекарств включает фактор даже днём.
    const missedMeds = evaluateExecutiveOverload({
      timezone: 'UTC',
      now: NOW,
      missedMedsCount: 1,
    });
    expect(missedMeds.factors.circadianOrTherapyLoad).toBe(true);
  });

  it('emotionalDistressMarker: распознаёт RU/EN маркеры с нормализацией ё -> е и типографского апострофа', () => {
    expect(detectOverloadMarkers('не могу начать, полный перегруз и ступор')).toEqual([
      'не могу начать',
      'перегруз',
      'ступор',
    ]);
    expect(detectOverloadMarkers('Всё навалилось сегодня')).toEqual(['все навалилось']);
    expect(detectOverloadMarkers('Feeling overwhelmed and can’t start')).toEqual([
      'overwhelmed',
      "can't start",
    ]);
    expect(detectOverloadMarkers('Купить молоко и хлеб')).toEqual([]);

    const state = evaluateExecutiveOverload({
      timezone: 'UTC',
      now: NOW,
      userText: 'Всё навалилось, overwhelmed, can’t start',
    });
    expect(state.factors.emotionalDistressMarker).toBe(true);
    expect(state.matchedMarkers).toEqual(['все навалилось', 'overwhelmed', "can't start"]);
  });

  it('активация: lowStimulationMode всегда включает щит; одиночный не-дистрессовый фактор — нет; >= 2 факторов или маркер + нагрузка — да', () => {
    // Ручной lowStimulationMode всегда активирует щит даже на пустых счётчиках днём.
    const manualCalm = evaluateExecutiveOverload({
      lowStimulationMode: true,
      timezone: 'UTC',
      now: NOW,
    });
    expect(manualCalm.activeFactorCount).toBe(0);
    expect(manualCalm.isOverloaded).toBe(true);

    // Одиночный не-дистрессовый фактор (вечер при нулевой нагрузке и без маркеров) -> false.
    const eveningAlone = evaluateExecutiveOverload({
      timezone: 'Europe/Moscow',
      now: new Date('2026-11-06T19:30:00Z'),
      activeTodoCount: 0,
      overdueTaskCount: 0,
      missedMedsCount: 0,
    });
    expect(eveningAlone.factors.circadianOrTherapyLoad).toBe(true);
    expect(eveningAlone.activeFactorCount).toBe(1);
    expect(eveningAlone.isOverloaded).toBe(false);

    // >= 2 из 3 факторов -> true (wipOverload + circadianOrTherapyLoad).
    const twoFactors = evaluateExecutiveOverload({
      timezone: 'Europe/Moscow',
      now: new Date('2026-11-06T19:30:00Z'),
      overdueTaskCount: 3,
      activeTodoCount: 3,
    });
    expect(twoFactors.activeFactorCount).toBe(2);
    expect(twoFactors.isOverloaded).toBe(true);

    // Эмоциональный дистресс без активной нагрузки -> false.
    const distressNoLoad = evaluateExecutiveOverload({
      timezone: 'UTC',
      now: NOW,
      userText: 'перегруз и ступор',
      activeTodoCount: 0,
      overdueTaskCount: 0,
      missedMedsCount: 0,
    });
    expect(distressNoLoad.factors.emotionalDistressMarker).toBe(true);
    expect(distressNoLoad.activeFactorCount).toBe(1);
    expect(distressNoLoad.isOverloaded).toBe(false);

    // Эмоциональный дистресс + любая активная нагрузка (> 0) -> true даже при 1 факторе.
    const distressWithTodo = evaluateExecutiveOverload({
      timezone: 'UTC',
      now: NOW,
      userText: 'не могу начать',
      activeTodoCount: 1,
    });
    expect(distressWithTodo.activeFactorCount).toBe(1);
    expect(distressWithTodo.isOverloaded).toBe(true);

    const distressWithMissedMed = evaluateExecutiveOverload({
      timezone: 'UTC',
      now: NOW,
      userText: 'overwhelmed',
      missedMedsCount: 1,
    });
    expect(distressWithMissedMed.isOverloaded).toBe(true);
  });

  it('buildSystemPrompt помещает щит в динамический хвост и сохраняет побайтовую идентичность статического префикса', () => {
    const tools: ToolSummary[] = [
      {
        name: 'list_tasks',
        description: 'Список задач.',
        schema: { type: 'object', properties: {} },
      },
    ];
    const shared = {
      mode: 'action' as const,
      tools,
      maxSteps: 8,
      now: NOW,
      profile: {
        userName: 'Тестовый Пользователь',
        timezone: 'Europe/Moscow',
        baseCurrency: 'EUR',
        personaStyle: 'mentor' as const,
        customInstructions: 'Отвечай кратко.',
      },
    };

    const normalOverload = evaluateExecutiveOverload({
      timezone: 'Europe/Moscow',
      now: NOW,
      activeTodoCount: 2,
    });
    const triggeredOverload = evaluateExecutiveOverload({
      timezone: 'Europe/Moscow',
      now: NOW,
      overdueTaskCount: 4,
      activeTodoCount: 4,
      missedMedsCount: 1,
      userText: 'ступор',
    });

    const normalPrompt = buildSystemPrompt({
      ...shared,
      executiveOverload: normalOverload,
    });
    const overloadedPrompt = buildSystemPrompt({
      ...shared,
      executiveOverload: triggeredOverload,
    });
    const manualCalmPrompt = buildSystemPrompt({
      ...shared,
      profile: { ...shared.profile, lowStimulationMode: true },
    });

    const dateMarker = 'ТЕКУЩЕЕ ВРЕМЯ И КАЛЕНДАРЬ:';
    const shieldMarker = '[РЕЖИМ СБЕРЕЖЕНИЯ ВНИМАНИЯ / EXECUTIVE OVERLOAD SHIELD]';

    expect(normalPrompt).not.toContain(shieldMarker);
    expect(overloadedPrompt).toContain(shieldMarker);
    expect(manualCalmPrompt).toContain(shieldMarker);

    const idxNormal = normalPrompt.indexOf(dateMarker);
    const idxOverloaded = overloadedPrompt.indexOf(dateMarker);
    const idxManualCalm = manualCalmPrompt.indexOf(dateMarker);

    expect(idxNormal).toBeGreaterThan(0);
    expect(idxOverloaded).toBe(idxNormal);
    expect(idxManualCalm).toBe(idxNormal);

    // Статический префикс до динамического хвоста побайтово идентичен для prompt caching.
    expect(overloadedPrompt.slice(0, idxOverloaded)).toBe(normalPrompt.slice(0, idxNormal));
    expect(manualCalmPrompt.slice(0, idxManualCalm)).toBe(normalPrompt.slice(0, idxNormal));

    // Щит строго после блока даты в динамическом хвосте.
    expect(overloadedPrompt.indexOf(shieldMarker)).toBeGreaterThan(idxOverloaded);
    expect(manualCalmPrompt.indexOf(shieldMarker)).toBeGreaterThan(idxManualCalm);

    // Каталог встроенных .md-скиллов попадает в кэшируемый префикс до даты (progressive disclosure).
    expect(normalPrompt).toContain('КАТАЛОГ ДОМЕННЫХ СКИЛЛОВ');
    expect(normalPrompt).toContain('inbox-triage');
    expect(normalPrompt).toContain('read_skill');
    expect(normalPrompt.indexOf('КАТАЛОГ ДОМЕННЫХ СКИЛЛОВ')).toBeLessThan(idxNormal);
  });
});

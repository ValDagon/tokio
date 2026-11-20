/**
 * BYOK-крипта: шифрование пользовательских Gemini-ключей.
 *
 * Схема (SPEC §2.3, §2.6):
 *  - из мастер-ключа приложения выводится персональный ключ пользователя:
 *    `KDF(user) = HMAC-SHA256(MASTER_KEY, 'byok:' + userId)` (32 байта);
 *  - ключ шифруется потоковым ChaCha20 (RFC 8439) со случайным 12-байтовым
 *    nonce и начальным счётчиком 1;
 *  - в БД лежат hex-строки `byok_ciphertext` / `byok_nonce`; `byok_tag`
 *    остаётся пустым — AEAD-тега у ChaCha20 нет.
 *
 * Всё на чистом TS (`src/lib/vendor/crypto.ts`): WebCrypto на платформе не документирован,
 * `Buffer` недоступен, `node:crypto` в изоляте нет. Единственное место, где
 * нужна платформа, — источник случайности:
 *  - источник случайности — только платформенный CSPRNG; если платформа его не
 *    даёт, `randomBytes()` падает (fail-closed), а доступность видна через
 *    `hasSecureRandom()`.
 *
 * Разные пользователи шифруются разными ключами, поэтому одна и та же строка
 * `byok:<api key>` даёт у них разные ciphertext'ы; подмена `user_id` в БД
 * ломает расшифровку (получится мусор, а не чужой ключ).
 */

import { getConfig } from './config.js';
import { chacha20Decrypt, chacha20Encrypt, hmacSha256 } from './vendor/crypto.js';

/** Длина nonce ChaCha20 (IETF-вариант с 32-битным счётчиком). */
export const BYOK_NONCE_BYTES = 12;
/** Длина ключа ChaCha20. */
export const BYOK_KEY_BYTES = 32;
/** Начальный счётчик блоков — как в RFC 8439 §2.4 (первые 64 байта keystream). */
export const BYOK_COUNTER = 1;

/** Префикс сообщения KDF; менять нельзя — сломает все сохранённые ключи. */
const KDF_PREFIX = 'byok:';

/** Что лежит в БД после `encryptByok`. */
export interface ByokRecord {
  /** hex(ChaCha20(apiKey)). */
  ciphertext: string;
  /** hex(nonce, 12 байт). */
  nonce: string;
}

// ---------------------------------------------------------------------------
// Байты ↔ строки (без TextEncoder/Buffer)
// ---------------------------------------------------------------------------

const HEX_CHARS = '0123456789abcdef';

/** Uint8Array → нижний hex. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i]!;
    out += HEX_CHARS[byte >>> 4]! + HEX_CHARS[byte & 0x0f]!;
  }
  return out;
}

/** Нижний hex → Uint8Array. Нечётная длина и мусор — ошибка. */
export function hexToBytes(hex: string): Uint8Array {
  const text = String(hex ?? '').trim().toLowerCase();
  if (text.length % 2 !== 0) throw new Error('crypto.hexToBytes: odd hex length');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`crypto.hexToBytes: invalid hex "${hex}"`);
    out[i] = byte;
  }
  return out;
}

/** Строка → UTF-8 байты (сурогатные пары поддерживаются). */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** UTF-8 байты → строка. */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const first = bytes[i]!;
    let code: number;
    let extra: number;
    if (first < 0x80) {
      code = first;
      extra = 0;
    } else if ((first & 0xe0) === 0xc0) {
      code = first & 0x1f;
      extra = 1;
    } else if ((first & 0xf0) === 0xe0) {
      code = first & 0x0f;
      extra = 2;
    } else if ((first & 0xf8) === 0xf0) {
      code = first & 0x07;
      extra = 3;
    } else {
      // Битая последовательность: не бросаем, а подставляем замену — так
      // расшифровка «чужим ключом» деградирует предсказуемо.
      out += '\uFFFD';
      i += 1;
      continue;
    }

    if (i + extra >= bytes.length) {
      out += '\uFFFD';
      break;
    }
    for (let k = 1; k <= extra; k += 1) {
      const next = bytes[i + k]!;
      if ((next & 0xc0) !== 0x80) {
        code = -1;
        break;
      }
      code = (code << 6) | (next & 0x3f);
    }
    i += extra + 1;
    if (code < 0) {
      out += '\uFFFD';
      continue;
    }
    if (code > 0xffff) {
      const shifted = code - 0x10000;
      out += String.fromCharCode(0xd800 + (shifted >> 10), 0xdc00 + (shifted & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Источник случайности
// ---------------------------------------------------------------------------

/** Минимум, который нам нужен от платформенного CSPRNG. */
interface CryptoLike {
  getRandomValues(array: Uint8Array): Uint8Array;
}

/** Платформенный `crypto`, если он есть. Проверяем `typeof`, а не факт наличия. */
function platformCrypto(): CryptoLike | null {
  const candidate = (globalThis as { crypto?: unknown }).crypto;
  if (!candidate || typeof candidate !== 'object') return null;
  const getRandomValues = (candidate as { getRandomValues?: unknown }).getRandomValues;
  if (typeof getRandomValues !== 'function') return null;
  return candidate as CryptoLike;
}

/** Есть ли на платформе CSPRNG. Health-флаг и гейт для записи BYOK. */
export function hasSecureRandom(): boolean {
  return platformCrypto() !== null;
}

/**
 * Случайные байты из платформенного CSPRNG.
 *
 * Fail-closed: без `crypto.getRandomValues` функция бросает ошибку и не
 * подменяет источник случайности. Расшифровка старых BYOK-записей от этого не
 * зависит — она случайность не запрашивает. `hasSecureRandom()` отвечает на
 * вопрос «есть ли платформенный генератор», а не «сработает ли он»: если
 * `getRandomValues` существует и бросает, ошибка уходит наверх, слабых байтов
 * не будет.
 */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error(`crypto.randomBytes: invalid length ${String(length)}`);
  }

  const crypto = platformCrypto();
  if (crypto) {
    const out = new Uint8Array(length);
    crypto.getRandomValues(out);
    return out;
  }

  throw new Error(
    'crypto.randomBytes: secure random source unavailable (globalThis.crypto.getRandomValues)',
  );
}

/** Свежий nonce для BYOK-записи (12 байт). */
export function newNonce(): Uint8Array {
  return randomBytes(BYOK_NONCE_BYTES);
}

// ---------------------------------------------------------------------------
// KDF
// ---------------------------------------------------------------------------

/**
 * Персональный ключ шифрования пользователя:
 * `HMAC-SHA256(MASTER_KEY, 'byok:' + userId)`, первые 32 байта (весь дайджест).
 *
 * @param userId    telegram user id
 * @param masterKey мастер-ключ; по умолчанию — из конфига (`MASTER_KEY`)
 */
export async function deriveKey(userId: number, masterKey?: string): Promise<Uint8Array> {
  const master = (masterKey ?? (await getConfig()).masterKey).trim();
  if (!master) {
    throw new Error('crypto.deriveKey: MASTER_KEY is not configured');
  }
  const digest = hmacSha256(utf8Encode(master), utf8Encode(`${KDF_PREFIX}${Number(userId)}`));
  return digest.slice(0, BYOK_KEY_BYTES);
}

// ---------------------------------------------------------------------------
// BYOK
// ---------------------------------------------------------------------------

export interface EncryptByokOptions {
  /** Переопределение мастер-ключа (тесты, ротация). */
  masterKey?: string;
  /** Готовый nonce — только для тестов и векторов. */
  nonce?: Uint8Array;
}

/**
 * Шифрует API-ключ пользователя.
 *
 * Возвращает hex-строки — ровно то, что ложится в `users.byok_ciphertext` и
 * `users.byok_nonce`. `byok_tag` не заполняется: у ChaCha20 нет тега
 * аутентификации.
 */
export async function encryptByok(
  userId: number,
  apiKey: string,
  options: EncryptByokOptions = {},
): Promise<ByokRecord> {
  const plaintext = String(apiKey ?? '');
  if (!plaintext) throw new Error('crypto.encryptByok: api key is empty');

  const key = await deriveKey(userId, options.masterKey);
  const nonce = options.nonce ?? newNonce();
  if (nonce.length !== BYOK_NONCE_BYTES) {
    throw new Error(`crypto.encryptByok: nonce must be ${BYOK_NONCE_BYTES} bytes`);
  }

  const ciphertext = chacha20Encrypt(key, nonce, utf8Encode(plaintext), BYOK_COUNTER);
  return { ciphertext: bytesToHex(ciphertext), nonce: bytesToHex(nonce) };
}

export interface DecryptByokOptions {
  masterKey?: string;
}

/**
 * Расшифровывает API-ключ пользователя.
 *
 * Чужим ключом (другой `user_id` или другой `MASTER_KEY`) расшифровка не
 * бросает — ChaCha20 не аутентифицирует данные; вместо этого вернётся мусор.
 * Поэтому вызывающий код обязан проверять, что получился похожий на ключ
 * текст (см. `looksLikeApiKey`).
 */
export async function decryptByok(
  userId: number,
  ciphertext: string,
  nonce: string,
  options: DecryptByokOptions = {},
): Promise<string> {
  if (!ciphertext) throw new Error('crypto.decryptByok: ciphertext is empty');
  if (!nonce) throw new Error('crypto.decryptByok: nonce is empty');

  const key = await deriveKey(userId, options.masterKey);
  const nonceBytes = hexToBytes(nonce);
  if (nonceBytes.length !== BYOK_NONCE_BYTES) {
    throw new Error(`crypto.decryptByok: nonce must be ${BYOK_NONCE_BYTES} bytes`);
  }

  const plaintext = chacha20Decrypt(key, nonceBytes, hexToBytes(ciphertext), BYOK_COUNTER);
  return utf8Decode(plaintext);
}

/**
 * Грубая проверка, что расшифровка дала именно ключ, а не мусор.
 *
 * Gemini-ключи — печатаемый ASCII без пробелов (`AIza…`, `AQ.…`). Проверка не
 * криптографическая: она только отсекает очевидный мусор после расшифровки
 * чужим ключом.
 */
export function looksLikeApiKey(value: string): boolean {
  const text = String(value ?? '').trim();
  if (text.length < 16) return false;
  return /^[\x21-\x7e]+$/.test(text);
}

/**
 * Полный путь сохранения BYOK: шифрует ключ и возвращает запись в форме
 * `users.byok` (`tag` пустой — колонка остаётся для совместимости схемы).
 */
export async function sealByok(
  userId: number,
  apiKey: string,
  options: EncryptByokOptions = {},
): Promise<{ ciphertext: string; nonce: string; tag: string }> {
  const record = await encryptByok(userId, apiKey, options);
  return { ciphertext: record.ciphertext, nonce: record.nonce, tag: '' };
}

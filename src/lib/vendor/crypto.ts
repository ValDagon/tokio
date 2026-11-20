/**
 * Вендорная крипта: SHA-256, HMAC-SHA256 и ChaCha20 на чистом TypeScript.
 *
 * Один модуль, а не три, потому что у платформы жёсткий лимит модулей на
 * приложение (`Too many modules per app`, 100 штук). Примитивы всё равно
 * изолированы по секциям и не знают друг о друге, кроме естественной
 * зависимости HMAC → SHA-256.
 *
 * Зачем своё вместо платформенного: в изоляте tgcloud нет node_modules/WASM,
 * `crypto.subtle` не документирован, а вендорить надо исходником (SPEC §2.3).
 * Работаем только с `Uint8Array` — `Buffer` на платформе недоступен.
 *
 * Секции:
 *  1. SHA-256 (FIPS 180-4) — потоково: `update()` сколько угодно раз;
 *  2. HMAC-SHA256 (RFC 2104 / FIPS 198-1) — поверх секции 1;
 *  3. ChaCha20 (RFC 8439 §2.3–2.4) — только потоковое шифрование, без AEAD.
 *
 * Потребитель — `lib/crypto.ts` (BYOK: вывод ключа пользователя и шифрование
 * его Gemini-ключа). Тесты ходят через шимы `src/vendor/*`.
 */

// ===========================================================================
// 1. SHA-256 (FIPS 180-4)
// ===========================================================================
//
// Использование:
//   sha256(bytes)                       — разовый хэш (32 байта);
//   new Sha256().update(a).update(b).digest() — потоково, без склейки кусков;
//   sha256Hex(bytes)                    — hex-строка (64 символа).
//
// Внутреннее состояние — 8 слов по 32 бита; блок 64 байта; длина считается в
// байтах (`Number`, до 2^53 — недостижимо для изолята), в финальный блок
// пишется как 64-битное big-endian число бит.

/** Первые 32 бита дробных частей кубических корней первых 64 простых чисел. */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Начальные значения: первые 32 бита дробных частей квадратных корней простых 2..19. */
const SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_BLOCK_BYTES = 64;
const SHA256_DIGEST_BYTES = 32;

/** Циклический сдвиг 32-битного слова вправо. */
const rotr = (value: number, shift: number): number =>
  ((value >>> shift) | (value << (32 - shift))) >>> 0;

/** Инкрементальный SHA-256: `update()` можно звать сколько угодно раз. */
export class Sha256 {
  private readonly state = new Uint32Array(SHA256_INIT);
  private readonly block = new Uint8Array(SHA256_BLOCK_BYTES);
  private readonly schedule = new Uint32Array(64);
  private blockLength = 0;
  private totalBytes = 0;
  private finished = false;

  /** Добавляет кусок сообщения. Возвращает `this` — удобно чейнить. */
  update(data: Uint8Array): this {
    if (this.finished) throw new Error('sha256: update() after digest()');
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.totalBytes += input.length;

    let offset = 0;

    // Добиваем начатый блок.
    if (this.blockLength > 0) {
      const need = SHA256_BLOCK_BYTES - this.blockLength;
      const take = Math.min(need, input.length);
      this.block.set(input.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset += take;
      if (this.blockLength === SHA256_BLOCK_BYTES) {
        this.compress(this.block, 0);
        this.blockLength = 0;
      }
    }

    // Целые блоки — прямо из входа, без копирования.
    while (offset + SHA256_BLOCK_BYTES <= input.length) {
      this.compress(input, offset);
      offset += SHA256_BLOCK_BYTES;
    }

    // Хвост оставляем в буфере.
    if (offset < input.length) {
      this.block.set(input.subarray(offset), 0);
      this.blockLength = input.length - offset;
    }

    return this;
  }

  /** Возвращает 32-байтовый хэш. Повторный вызов — ошибка (состояние уже свёрнуто). */
  digest(): Uint8Array {
    if (this.finished) throw new Error('sha256: digest() called twice');
    this.finished = true;

    const tail = new Uint8Array(
      this.blockLength < SHA256_BLOCK_BYTES ? SHA256_BLOCK_BYTES * 2 : SHA256_BLOCK_BYTES,
    );
    tail.set(this.block.subarray(0, this.blockLength));
    tail[this.blockLength] = 0x80;

    // Если после 0x80 не остаётся 8 байт под длину — нужен ещё один блок.
    const tailLength =
      this.blockLength + 1 + 8 > SHA256_BLOCK_BYTES ? SHA256_BLOCK_BYTES * 2 : SHA256_BLOCK_BYTES;

    // Длина сообщения в битах как 64-битное big-endian (hi:lo).
    const bits = this.totalBytes * 8;
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    const lengthOffset = tailLength - 8;
    tail[lengthOffset] = (hi >>> 24) & 0xff;
    tail[lengthOffset + 1] = (hi >>> 16) & 0xff;
    tail[lengthOffset + 2] = (hi >>> 8) & 0xff;
    tail[lengthOffset + 3] = hi & 0xff;
    tail[lengthOffset + 4] = (lo >>> 24) & 0xff;
    tail[lengthOffset + 5] = (lo >>> 16) & 0xff;
    tail[lengthOffset + 6] = (lo >>> 8) & 0xff;
    tail[lengthOffset + 7] = lo & 0xff;

    for (let offset = 0; offset < tailLength; offset += SHA256_BLOCK_BYTES) {
      this.compress(tail, offset);
    }

    const out = new Uint8Array(SHA256_DIGEST_BYTES);
    for (let i = 0; i < 8; i += 1) {
      const word = this.state[i]!;
      out[i * 4] = (word >>> 24) & 0xff;
      out[i * 4 + 1] = (word >>> 16) & 0xff;
      out[i * 4 + 2] = (word >>> 8) & 0xff;
      out[i * 4 + 3] = word & 0xff;
    }
    return out;
  }

  /** Обрабатывает один 64-байтовый блок, начиная с `offset` в `source`. */
  private compress(source: Uint8Array, offset: number): void {
    const w = this.schedule;

    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] =
        ((source[j]! << 24) | (source[j + 1]! << 16) | (source[j + 2]! << 8) | source[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    const s = this.state;
    let a = s[0]!;
    let b = s[1]!;
    let c = s[2]!;
    let d = s[3]!;
    let e = s[4]!;
    let f = s[5]!;
    let g = s[6]!;
    let h = s[7]!;

    for (let i = 0; i < 64; i += 1) {
      const sigma1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + sigma1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const sigma0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (sigma0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    s[0] = (s[0]! + a) >>> 0;
    s[1] = (s[1]! + b) >>> 0;
    s[2] = (s[2]! + c) >>> 0;
    s[3] = (s[3]! + d) >>> 0;
    s[4] = (s[4]! + e) >>> 0;
    s[5] = (s[5]! + f) >>> 0;
    s[6] = (s[6]! + g) >>> 0;
    s[7] = (s[7]! + h) >>> 0;
  }
}

/** SHA-256 от буфера — 32 байта. */
export function sha256(data: Uint8Array): Uint8Array {
  return new Sha256().update(data).digest();
}

const HEX_CHARS = '0123456789abcdef';

/** SHA-256 в нижнем hex — 64 символа. */
export function sha256Hex(data: Uint8Array): string {
  const digest = sha256(data);
  let out = '';
  for (let i = 0; i < digest.length; i += 1) {
    const byte = digest[i]!;
    out += HEX_CHARS[byte >>> 4]! + HEX_CHARS[byte & 0x0f]!;
  }
  return out;
}

// ===========================================================================
// 2. HMAC-SHA256 (RFC 2104 / FIPS 198-1)
// ===========================================================================
//
//   HMAC(K, m) = H((K' ⊕ opad) ‖ H((K' ⊕ ipad) ‖ m))
//   K' = K, если |K| ≤ B; иначе H(K); B = 64 байта (блок SHA-256).
//
// Нужен для BYOK: из мастер-ключа выводится ключ шифрования пользователя
// (`crypto.ts`), поэтому реализация не должна зависеть ни от WebCrypto, ни от
// node-модулей (SPEC §2.3).

const HMAC_BLOCK_BYTES = 64;
const HMAC_IPAD = 0x36;
const HMAC_OPAD = 0x5c;

/** Готовит 64-байтовый ключевой блок: длинный ключ сначала хэшируется. */
function normalizeKey(key: Uint8Array): Uint8Array {
  const block = new Uint8Array(HMAC_BLOCK_BYTES);
  if (key.length > HMAC_BLOCK_BYTES) {
    block.set(new Sha256().update(key).digest(), 0);
  } else {
    block.set(key, 0);
  }
  return block;
}

/** HMAC-SHA256 — 32 байта. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const keyBlock = normalizeKey(key);

  const innerPad = new Uint8Array(HMAC_BLOCK_BYTES);
  const outerPad = new Uint8Array(HMAC_BLOCK_BYTES);
  for (let i = 0; i < HMAC_BLOCK_BYTES; i += 1) {
    const byte = keyBlock[i]!;
    innerPad[i] = byte ^ HMAC_IPAD;
    outerPad[i] = byte ^ HMAC_OPAD;
  }

  const inner = new Sha256().update(innerPad).update(message).digest();
  return new Sha256().update(outerPad).update(inner).digest();
}

// ===========================================================================
// 3. ChaCha20 (RFC 8439 §2.3–2.4)
// ===========================================================================
//
// Это ТОЛЬКО потоковое шифрование: 32-байтовый ключ, 12-байтовый nonce,
// 32-битный счётчик блоков. Poly1305/AEAD намеренно нет (SPEC §2.6: «pure-TS
// ChaCha20 + HMAC-SHA256, вендор»), целостность BYOK-записи обеспечивается
// тем, что расшифровка мусора не даёт валидного API-ключа — плюс проверка
// префикса ключа на уровне `lib/crypto.ts`.
//
// Шифрование и дешифрование — одна и та же операция (XOR с keystream).

const CHACHA_KEY_BYTES = 32;
const CHACHA_NONCE_BYTES = 12;
const CHACHA_BLOCK_BYTES = 64;
const CHACHA_ROUNDS = 20;

/** «expand 32-byte k» — сигнатура состояния, little-endian слова. */
const CHACHA_SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

/** Циклический сдвиг 32-битного слова влево. */
const rotl = (value: number, shift: number): number =>
  ((value << shift) | (value >>> (32 - shift))) >>> 0;

/** Чтение little-endian 32-битного слова. */
function readWord(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
  );
}

/** Запись little-endian 32-битного слова. */
function writeWord(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

/** QUARTERROUND (RFC 8439 §2.1) над рабочим состоянием, мутируя его. */
function quarterRound(x: Uint32Array, a: number, b: number, c: number, d: number): void {
  x[a] = (x[a]! + x[b]!) >>> 0;
  x[d] = rotl(x[d]! ^ x[a]!, 16);
  x[c] = (x[c]! + x[d]!) >>> 0;
  x[b] = rotl(x[b]! ^ x[c]!, 12);
  x[a] = (x[a]! + x[b]!) >>> 0;
  x[d] = rotl(x[d]! ^ x[a]!, 8);
  x[c] = (x[c]! + x[d]!) >>> 0;
  x[b] = rotl(x[b]! ^ x[c]!, 7);
}

/** Собирает исходное состояние: константы | ключ | счётчик | nonce. */
function initialState(key: Uint8Array, counter: number, nonce: Uint8Array): Uint32Array {
  if (key.length !== CHACHA_KEY_BYTES) {
    throw new Error(`chacha20: key must be ${CHACHA_KEY_BYTES} bytes, got ${key.length}`);
  }
  if (nonce.length !== CHACHA_NONCE_BYTES) {
    throw new Error(`chacha20: nonce must be ${CHACHA_NONCE_BYTES} bytes, got ${nonce.length}`);
  }

  const state = new Uint32Array(16);
  state[0] = CHACHA_SIGMA[0]!;
  state[1] = CHACHA_SIGMA[1]!;
  state[2] = CHACHA_SIGMA[2]!;
  state[3] = CHACHA_SIGMA[3]!;
  for (let i = 0; i < 8; i += 1) state[4 + i] = readWord(key, i * 4);
  state[12] = counter >>> 0;
  for (let i = 0; i < 3; i += 1) state[13 + i] = readWord(nonce, i * 4);
  return state;
}

/**
 * Блок функции ChaCha20 — 64 байта keystream (RFC 8439 §2.3).
 * Вектор из §2.3.2: key 00..1f, counter 1, nonce 000000090000004a00000000.
 */
export function chacha20Block(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
  const state = initialState(key, counter, nonce);
  const working = new Uint32Array(state);

  for (let i = 0; i < CHACHA_ROUNDS; i += 2) {
    // Колонки.
    quarterRound(working, 0, 4, 8, 12);
    quarterRound(working, 1, 5, 9, 13);
    quarterRound(working, 2, 6, 10, 14);
    quarterRound(working, 3, 7, 11, 15);
    // Диагонали.
    quarterRound(working, 0, 5, 10, 15);
    quarterRound(working, 1, 6, 11, 12);
    quarterRound(working, 2, 7, 8, 13);
    quarterRound(working, 3, 4, 9, 14);
  }

  const out = new Uint8Array(CHACHA_BLOCK_BYTES);
  for (let i = 0; i < 16; i += 1) {
    writeWord(out, i * 4, (working[i]! + state[i]!) >>> 0);
  }
  return out;
}

/**
 * XOR данных с keystream ChaCha20.
 *
 * @param key     32-байтовый ключ
 * @param nonce   12-байтовый nonce (IETF-вариант)
 * @param data    входные байты (шифрование = дешифрование)
 * @param counter начальный счётчик блоков (RFC 8439 шифрует с 1)
 */
export function chacha20(
  key: Uint8Array,
  nonce: Uint8Array,
  data: Uint8Array,
  counter: number = 1,
): Uint8Array {
  // Валидация до выделения памяти: неверные размеры — ошибка вызывающего.
  initialState(key, counter, nonce);

  const out = new Uint8Array(data.length);
  const block = new Uint8Array(CHACHA_BLOCK_BYTES);
  let position = 0;
  let blockCounter = counter;

  while (position < data.length) {
    const keystream = chacha20Block(key, blockCounter, nonce);
    block.set(keystream);
    const take = Math.min(CHACHA_BLOCK_BYTES, data.length - position);
    for (let i = 0; i < take; i += 1) {
      out[position + i] = data[position + i]! ^ block[i]!;
    }
    position += take;
    blockCounter += 1;
  }

  return out;
}

/** Шифрование (синоним `chacha20` — операция симметрична). */
export function chacha20Encrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  counter: number = 1,
): Uint8Array {
  return chacha20(key, nonce, plaintext, counter);
}

/** Дешифрование (синоним `chacha20` — операция симметрична). */
export function chacha20Decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  counter: number = 1,
): Uint8Array {
  return chacha20(key, nonce, ciphertext, counter);
}

/**
 * Крипто-слой: вендорные примитивы (`src/vendor/*`) и BYOK (`src/lib/crypto.ts`).
 *
 * Примитивы проверяются официальными векторами, а не «сам с собой»:
 *  - SHA-256 — FIPS 180-4 / `sha256sum`;
 *  - HMAC — RFC 4231 (это же FIPS 198-1);
 *  - ChaCha20 — RFC 8439 §2.3.2 (блок keystream) и §2.4.2 (шифрование).
 *
 * Схема BYOK не аутентифицирует данные (ChaCha20 без тега), поэтому отдельный
 * тест фиксирует ожидаемое поведение: чужим ключом расшифровка не бросает, а
 * даёт мусор — проверять его обязан вызывающий код (`looksLikeApiKey`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sha256, sha256, sha256Hex } from '../src/vendor/sha256';
import { hmacSha256 } from '../src/vendor/hmac';
import {
  chacha20,
  chacha20Block,
  chacha20Decrypt,
  chacha20Encrypt,
} from '../src/vendor/chacha20';
import {
  BYOK_COUNTER,
  BYOK_KEY_BYTES,
  BYOK_NONCE_BYTES,
  bytesToHex,
  decryptByok,
  deriveKey,
  encryptByok,
  hexToBytes,
  hasSecureRandom,
  looksLikeApiKey,
  newNonce,
  randomBytes,
  sealByok,
  utf8Decode,
  utf8Encode,
} from '../src/lib/crypto';
import { resetConfigCache, setConfigOverrides } from '../src/lib/config';

const MASTER_KEY = 'unit-test-master-key';
const API_KEY = 'AIzaSyD-test-key-0123456789abcdefghi';

beforeEach(() => {
  resetConfigCache();
});

// ---------------------------------------------------------------------------
// Векторы
// ---------------------------------------------------------------------------

/** Ключ RFC 8439: байты 00 01 02 … 1f. */
function rfcKey(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, i) => i);
}

describe('vendor/sha256', () => {
  it('хеширует "abc" (FIPS 180-4)', () => {
    expect(sha256Hex(utf8Encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('хеширует пустую строку', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('хеширует данные длиннее одного блока одинаково в обоих API', () => {
    const data = utf8Encode('a'.repeat(1000));
    const oneShot = sha256(data);
    const streamed = new Sha256().update(data).digest();
    expect(bytesToHex(streamed)).toBe(bytesToHex(oneShot));
    expect(oneShot).toHaveLength(32);
  });
});

describe('vendor/hmac', () => {
  it('совпадает с RFC 4231, тест 1 (ключ 0x0b × 20)', () => {
    const key = new Uint8Array(20).fill(0x0b);
    expect(bytesToHex(hmacSha256(key, utf8Encode('Hi There')))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('совпадает с RFC 4231, тест 2 ("Jefe")', () => {
    expect(
      bytesToHex(hmacSha256(utf8Encode('Jefe'), utf8Encode('what do ya want for nothing?'))),
    ).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  it('ключ длиннее блока хешируется, а не обрезается (RFC 4231, тест 6)', () => {
    const key = new Uint8Array(131).fill(0xaa);
    expect(
      bytesToHex(
        hmacSha256(
          key,
          utf8Encode(
            'Test Using Larger Than Block-Size Key - Hash Key First',
          ),
        ),
      ),
    ).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  });
});

describe('vendor/chacha20 (RFC 8439)', () => {
  it('блок keystream §2.3.2', () => {
    const nonce = hexToBytes('000000090000004a00000000');
    expect(bytesToHex(chacha20Block(rfcKey(), 1, nonce))).toBe(
      '10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e' +
        'd2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e',
    );
  });

  it('шифрование §2.4.2 (счётчик начинается с 1)', () => {
    const plaintext = utf8Encode(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
    );
    const nonce = hexToBytes('000000000000004a00000000');
    const ciphertext = chacha20Encrypt(rfcKey(), nonce, plaintext, BYOK_COUNTER);

    expect(bytesToHex(ciphertext)).toBe(
      '6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b' +
        'f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8' +
        '07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736' +
        '5af90bbf74a35be6b40b8eedf2785e42874d',
    );
    expect(bytesToHex(chacha20Decrypt(rfcKey(), nonce, ciphertext, BYOK_COUNTER))).toBe(
      bytesToHex(plaintext),
    );
    expect(bytesToHex(chacha20(rfcKey(), nonce, plaintext, 1))).toBe(bytesToHex(ciphertext));
  });

  it('длина не кратна блоку и данные длиннее одного блока', () => {
    const key = rfcKey();
    const nonce = hexToBytes('000000000000004a00000000');
    const data = Uint8Array.from({ length: 200 }, (_, i) => i % 256);
    const ciphertext = chacha20Encrypt(key, nonce, data);
    expect(ciphertext).toHaveLength(200);
    expect(bytesToHex(chacha20Decrypt(key, nonce, ciphertext))).toBe(bytesToHex(data));
  });

  it('неверный размер ключа/nonce — ошибка', () => {
    const nonce = new Uint8Array(12);
    expect(() => chacha20(new Uint8Array(16), nonce, new Uint8Array(1))).toThrow();
    expect(() => chacha20(rfcKey(), new Uint8Array(8), new Uint8Array(1))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Байты и hex
// ---------------------------------------------------------------------------

describe('crypto: hex и UTF-8', () => {
  it('hex туда-обратно', () => {
    const bytes = Uint8Array.from([0x00, 0x0f, 0xa5, 0xff]);
    expect(bytesToHex(bytes)).toBe('000fa5ff');
    expect(bytesToHex(hexToBytes('000FA5FF'))).toBe('000fa5ff');
    expect(Array.from(hexToBytes('000fa5ff'))).toEqual([0, 15, 165, 255]);
  });

  it('нечётная длина и мусор — ошибки', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd hex length/);
    expect(() => hexToBytes('zz')).toThrow(/invalid hex/);
  });

  it('UTF-8 переживает кириллицу и эмодзи (сурогатные пары)', () => {
    const text = 'привет 🚀 мир';
    expect(utf8Decode(utf8Encode(text))).toBe(text);
    expect(Array.from(utf8Encode('€'))).toEqual([0xe2, 0x82, 0xac]);
  });

  it('битые байты декодируются в U+FFFD, а не бросают', () => {
    expect(utf8Decode(Uint8Array.from([0xff, 0xfe]))).toBe('\uFFFD\uFFFD');
  });
});

// ---------------------------------------------------------------------------
// Случайность
// ---------------------------------------------------------------------------

describe('crypto: randomBytes', () => {
  it('возвращает запрошенную длину', () => {
    expect(randomBytes(1)).toHaveLength(1);
    expect(randomBytes(BYOK_NONCE_BYTES)).toHaveLength(12);
    expect(newNonce()).toHaveLength(BYOK_NONCE_BYTES);
  });

  it('два вызова не совпадают (96 бит коллизий не дают)', () => {
    expect(bytesToHex(randomBytes(12))).not.toBe(bytesToHex(randomBytes(12)));
  });

  it('неположительная длина — ошибка', () => {
    expect(() => randomBytes(0)).toThrow(/invalid length/);
    expect(() => randomBytes(-1)).toThrow(/invalid length/);
  });
});

describe('crypto: fail-closed RNG', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('hasSecureRandom() видит платформенный CSPRNG', () => {
    expect(hasSecureRandom()).toBe(true);
    expect(newNonce()).toHaveLength(BYOK_NONCE_BYTES);
  });

  it('без crypto.getRandomValues падает и не трогает Math.random', () => {
    const randomSpy = vi.spyOn(Math, 'random');
    vi.stubGlobal('crypto', undefined);
    expect(hasSecureRandom()).toBe(false);
    expect(() => randomBytes(12)).toThrow(/secure random source unavailable/);
    expect(() => newNonce()).toThrow(/secure random source unavailable/);
    expect(randomSpy).not.toHaveBeenCalled();
  });

  it('crypto без getRandomValues тоже fail-closed', () => {
    vi.stubGlobal('crypto', {});
    expect(hasSecureRandom()).toBe(false);
    expect(() => randomBytes(12)).toThrow(/secure random source unavailable/);
  });

  it('существующая BYOK-запись расшифровывается без CSPRNG', async () => {
    const sealed = await encryptByok(42, API_KEY, { masterKey: MASTER_KEY });
    vi.stubGlobal('crypto', undefined);
    const plain = await decryptByok(42, sealed.ciphertext, sealed.nonce, {
      masterKey: MASTER_KEY,
    });
    expect(plain).toBe(API_KEY);
  });
});

// ---------------------------------------------------------------------------
// KDF
// ---------------------------------------------------------------------------

describe('crypto: deriveKey', () => {
  it('это HMAC-SHA256(master, "byok:" + userId), 32 байта', async () => {
    const expected = hmacSha256(utf8Encode(MASTER_KEY), utf8Encode('byok:42'));
    const derived = await deriveKey(42, MASTER_KEY);
    expect(derived).toHaveLength(BYOK_KEY_BYTES);
    expect(bytesToHex(derived)).toBe(bytesToHex(expected));
  });

  it('разные пользователи и разные мастер-ключи дают разные ключи', async () => {
    const a = bytesToHex(await deriveKey(1, MASTER_KEY));
    const b = bytesToHex(await deriveKey(2, MASTER_KEY));
    const c = bytesToHex(await deriveKey(1, 'another-master-key'));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('берёт MASTER_KEY из конфига, если он не передан', async () => {
    setConfigOverrides({ masterKey: MASTER_KEY });
    expect(bytesToHex(await deriveKey(7))).toBe(bytesToHex(await deriveKey(7, MASTER_KEY)));
  });

  it('без мастер-ключа — ошибка', async () => {
    setConfigOverrides({ masterKey: '' });
    await expect(deriveKey(7)).rejects.toThrow(/MASTER_KEY is not configured/);
  });
});

// ---------------------------------------------------------------------------
// BYOK
// ---------------------------------------------------------------------------

describe('crypto: BYOK', () => {
  it('roundtrip: encryptByok → decryptByok', async () => {
    const record = await encryptByok(42, API_KEY, { masterKey: MASTER_KEY });
    expect(record.nonce).toHaveLength(BYOK_NONCE_BYTES * 2);
    expect(record.ciphertext).toHaveLength(API_KEY.length * 2);

    const plaintext = await decryptByok(42, record.ciphertext, record.nonce, {
      masterKey: MASTER_KEY,
    });
    expect(plaintext).toBe(API_KEY);
  });

  it('разные nonce → разный ciphertext при том же ключе и тексте', async () => {
    const first = await encryptByok(42, API_KEY, { masterKey: MASTER_KEY });
    const second = await encryptByok(42, API_KEY, { masterKey: MASTER_KEY });
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('детерминирован при заданном nonce (вектор для отладки)', async () => {
    const nonce = hexToBytes('000000000000000000000000');
    const first = await encryptByok(42, API_KEY, { masterKey: MASTER_KEY, nonce });
    const second = await encryptByok(42, API_KEY, { masterKey: MASTER_KEY, nonce });
    expect(first.ciphertext).toBe(second.ciphertext);
  });

  it('чужой user_id расшифровывает в мусор, но не бросает', async () => {
    const record = await encryptByok(42, API_KEY, { masterKey: MASTER_KEY });
    const wrong = await decryptByok(43, record.ciphertext, record.nonce, {
      masterKey: MASTER_KEY,
    });
    expect(wrong).not.toBe(API_KEY);
  });

  it('чужой MASTER_KEY расшифровывает в мусор, но не бросает', async () => {
    const record = await encryptByok(42, API_KEY, { masterKey: MASTER_KEY });
    const wrong = await decryptByok(42, record.ciphertext, record.nonce, {
      masterKey: 'some-other-master-key',
    });
    expect(wrong).not.toBe(API_KEY);
  });

  it('sealByok даёт форму users.byok с пустым tag', async () => {
    const sealed = await sealByok(42, API_KEY, { masterKey: MASTER_KEY });
    expect(Object.keys(sealed).sort()).toEqual(['ciphertext', 'nonce', 'tag']);
    expect(sealed.tag).toBe('');
    expect(
      await decryptByok(42, sealed.ciphertext, sealed.nonce, { masterKey: MASTER_KEY }),
    ).toBe(API_KEY);
  });

  it('пустой ключ и пустые поля — ошибки', async () => {
    await expect(encryptByok(42, '', { masterKey: MASTER_KEY })).rejects.toThrow(
      /api key is empty/,
    );
    await expect(decryptByok(42, '', 'nonce', { masterKey: MASTER_KEY })).rejects.toThrow(
      /ciphertext is empty/,
    );
  });

  it('неверный размер nonce — ошибка', async () => {
    await expect(
      encryptByok(42, API_KEY, { masterKey: MASTER_KEY, nonce: new Uint8Array(8) }),
    ).rejects.toThrow(/nonce must be 12 bytes/);
  });
});

describe('crypto: looksLikeApiKey', () => {
  it('принимает печатаемый ключ', () => {
    expect(looksLikeApiKey(API_KEY)).toBe(true);
    expect(looksLikeApiKey('  AQ.FAKE_TEST_KEY_FOR_API_0123456789  ')).toBe(true);
  });

  it('отбрасывает короткий текст, пробелы и управляющие символы', () => {
    expect(looksLikeApiKey('short')).toBe(false);
    expect(looksLikeApiKey('')).toBe(false);
    expect(looksLikeApiKey('AQ. key with spaces 12345')).toBe(false);
    expect(looksLikeApiKey('AIza\u0000\u0001\u0002\u0003-0123456789')).toBe(false);
  });
});

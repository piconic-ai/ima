import { describe, expect, it } from 'vitest'
import {
  decodeKey,
  decrypt,
  encrypt,
  fromBase64Url,
  generateKey,
  importKey,
  toBase64Url,
} from '../src/index.ts'

describe('key', () => {
  it('generates 32-byte base64url keys', () => {
    const key = generateKey()
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(decodeKey(key)).toHaveLength(32)
    expect(generateKey()).not.toBe(key)
  })

  it('round-trips base64url', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255])
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes)
  })

  it('rejects malformed keys', () => {
    expect(() => decodeKey('short')).toThrow()
    expect(() => decodeKey('not base64url!')).toThrow()
  })
})

describe('cipher', () => {
  it('round-trips plaintext', async () => {
    const key = await importKey(generateKey())
    const plaintext = new TextEncoder().encode('# hello 居間')
    const ciphertext = await encrypt(key, plaintext)
    expect(ciphertext.length).toBe(12 + plaintext.length + 16)
    expect(await decrypt(key, ciphertext)).toEqual(plaintext)
  })

  it('uses a fresh IV each time', async () => {
    const key = await importKey(generateKey())
    const plaintext = new Uint8Array([1, 2, 3])
    expect(await encrypt(key, plaintext)).not.toEqual(await encrypt(key, plaintext))
  })

  it('fails to decrypt with a different key', async () => {
    const ciphertext = await encrypt(await importKey(generateKey()), new Uint8Array([1, 2, 3]))
    await expect(decrypt(await importKey(generateKey()), ciphertext)).rejects.toThrow()
  })

  it('fails to decrypt tampered data', async () => {
    const key = await importKey(generateKey())
    const ciphertext = await encrypt(key, new Uint8Array([1, 2, 3]))
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1
    await expect(decrypt(key, ciphertext)).rejects.toThrow()
  })
})

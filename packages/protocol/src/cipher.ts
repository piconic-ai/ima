const IV_BYTES = 12

// WebCrypto's typings reject views over SharedArrayBuffer; ours never are.
const buf = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>

/** Encrypts with AES-GCM and returns `iv || ciphertext`. */
export async function encrypt(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    buf(plaintext),
  )
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ciphertext), IV_BYTES)
  return out
}

/** Reverses `encrypt`. Throws if the key is wrong or the data was tampered with. */
export async function decrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  if (data.length <= IV_BYTES) throw new Error('ciphertext too short')
  const iv = data.subarray(0, IV_BYTES)
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf(iv) },
    key,
    buf(data.subarray(IV_BYTES)),
  )
  return new Uint8Array(plaintext)
}

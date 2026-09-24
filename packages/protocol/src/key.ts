const KEY_BYTES = 32

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('invalid base64url')
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function randomBase64Url(byteLength: number): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(byteLength)))
}

/** Generates a new room key, encoded as base64url for use in a URL fragment. */
export function generateKey(): string {
  return randomBase64Url(KEY_BYTES)
}

export function decodeKey(encoded: string): Uint8Array {
  const raw = fromBase64Url(encoded)
  if (raw.length !== KEY_BYTES) throw new Error(`key must be ${KEY_BYTES} bytes`)
  return raw
}

export function importKey(encoded: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    decodeKey(encoded) as Uint8Array<ArrayBuffer>,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  )
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { VaultError } from './contracts'

export interface Sealed { nonce: string; tag: string; ciphertext: string }
export function seal(key: Buffer, plaintext: Buffer, binding: string): Sealed {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(Buffer.from(binding, 'utf8'))
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') }
}
export function unseal(key: Buffer, value: Sealed, binding: string): Buffer {
  const nonce = decode(value.nonce), tag = decode(value.tag), ciphertext = decode(value.ciphertext)
  if (nonce.length !== 12 || tag.length !== 16 || key.length !== 32) throw new VaultError('DATA_DAMAGED')
  let partial: Buffer | undefined
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
    decipher.setAAD(Buffer.from(binding, 'utf8'))
    decipher.setAuthTag(tag)
    partial = decipher.update(ciphertext)
    return Buffer.concat([partial, decipher.final()])
  } catch { throw new VaultError('DATA_DAMAGED') }
  finally { partial?.fill(0) }
}
export function decode(value: string): Buffer {
  if (typeof value !== 'string') throw new VaultError('DATA_DAMAGED')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new VaultError('DATA_DAMAGED')
  return bytes
}
export function serialize(value: unknown): Buffer { return Buffer.from(JSON.stringify(value), 'utf8') }
export function sealedJson(key: Buffer, value: unknown, binding: string): Sealed {
  const bytes = serialize(value)
  try { return seal(key, bytes, binding) } finally { bytes.fill(0) }
}
export function openedJson(key: Buffer, value: Sealed, binding: string): unknown {
  const bytes = unseal(key, value, binding)
  try { return JSON.parse(bytes.toString('utf8')) as unknown }
  catch { throw new VaultError('DATA_DAMAGED') }
  finally { bytes.fill(0) }
}

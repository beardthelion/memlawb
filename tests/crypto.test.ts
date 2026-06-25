import { describe, expect, test } from 'bun:test'
import { ciphertextHash, decryptEntry, deriveKey, encryptEntry } from '../client/crypto.ts'

describe('client crypto', () => {
  const key = deriveKey('correct horse battery staple', 'user:alice')

  test('roundtrips plaintext', () => {
    const pt = '# MEMORY\n- user is a data scientist\n'
    const ct = encryptEntry(key, 'MEMORY.md', pt)
    expect(decryptEntry(key, 'MEMORY.md', ct)).toBe(pt)
  })

  test('is deterministic (stable ciphertext for delta sync)', () => {
    const a = encryptEntry(key, 'feedback/x.md', 'same content')
    const b = encryptEntry(key, 'feedback/x.md', 'same content')
    expect(a).toBe(b)
    expect(ciphertextHash(a)).toBe(ciphertextHash(b))
  })

  test('different entry keys produce different ciphertext (AAD binding)', () => {
    const a = encryptEntry(key, 'a.md', 'content')
    const b = encryptEntry(key, 'b.md', 'content')
    expect(a).not.toBe(b)
  })

  test('wrong passphrase cannot decrypt', () => {
    const ct = encryptEntry(key, 'MEMORY.md', 'secret')
    const wrong = deriveKey('wrong passphrase', 'user:alice')
    expect(() => decryptEntry(wrong, 'MEMORY.md', ct)).toThrow()
  })

  test('swapping a ciphertext to another entry key fails (AAD binding)', () => {
    const ct = encryptEntry(key, 'a.md', 'content')
    expect(() => decryptEntry(key, 'b.md', ct)).toThrow()
  })

  test('namespace separation: same passphrase, different namespace ⇒ no decrypt', () => {
    const ct = encryptEntry(key, 'MEMORY.md', 'secret')
    const otherNs = deriveKey('correct horse battery staple', 'user:bob')
    expect(() => decryptEntry(otherNs, 'MEMORY.md', ct)).toThrow()
  })
})

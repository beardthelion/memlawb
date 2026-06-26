/**
 * Tenant isolation at the storage layer (namespaceSlug regression).
 *
 * `user:a/b` (owner "a") and `user:a__b` (owner "a__b") are two distinct,
 * both-valid namespaces owned by different accounts. Under the old slug scheme
 * (`ns.replace(/[:/]/g, '__')`) both mapped to the same storage segment
 * `user__a__b`, so they shared one manifest + entry directory: owner "a"'s read
 * returned owner "a__b"'s entries (cross-tenant leak) and their blobs clobbered
 * each other (cross-tenant corruption). This drives the real write/read path
 * (memory.ts) to prove the sha256 slug keeps them isolated.
 */

import { describe, expect, test } from 'bun:test'
import { getData, getHashes, upsert } from '../src/memory.ts'
import { namespaceSlug } from '../src/namespace.ts'

const NOW = '2026-06-24T00:00:00.000Z'

/** Opaque base64 "ciphertext" — the server never decrypts it. */
function blob(tag: string): string {
  return Buffer.from(`ciphertext:${tag}`).toString('base64')
}

function put(owner: string, ns: string, entries: Record<string, string>) {
  return upsert(ns, namespaceSlug(ns), owner, { entries }, NOW)
}

describe('tenant isolation (namespaceSlug)', () => {
  test('namespaces that collided under the old slug do not share storage', async () => {
    const aliceCt = blob('alice')
    const malloryCt = blob('mallory')

    await put('a', 'user:a/b', { 'alice.md': aliceCt })
    await put('a__b', 'user:a__b', { 'mallory.md': malloryCt })

    const alice = await getData('user:a/b', namespaceSlug('user:a/b'))
    const mallory = await getData('user:a__b', namespaceSlug('user:a__b'))

    // Each tenant sees only its own entry — no cross-tenant leak.
    expect(Object.keys(alice.content.entries).sort()).toEqual(['alice.md'])
    expect(alice.content.entries['alice.md']).toBe(aliceCt)
    expect(alice.content.entries['mallory.md']).toBeUndefined()

    expect(Object.keys(mallory.content.entries).sort()).toEqual(['mallory.md'])
    expect(mallory.content.entries['mallory.md']).toBe(malloryCt)

    // And the two tenants land on different storage segments.
    expect(namespaceSlug('user:a/b')).not.toBe(namespaceSlug('user:a__b'))
  })

  test('the metadata view (?view=hashes) is also isolated', async () => {
    await put('m', 'user:m/x', { 'secret.md': blob('m-secret') })
    await put('m__x', 'user:m__x', { 'other.md': blob('mx-other') })

    const a = await getHashes('user:m/x', namespaceSlug('user:m/x'))
    const b = await getHashes('user:m__x', namespaceSlug('user:m__x'))

    // entryChecksums (entry keys + hashes) must not leak across the boundary.
    expect(Object.keys(a.entryChecksums)).toEqual(['secret.md'])
    expect(Object.keys(b.entryChecksums)).toEqual(['other.md'])
  })

  test('same entry key in colliding namespaces does not clobber across tenants', async () => {
    // Both tenants use the SAME entry key. Under the old slug the second write
    // overwrote the first's blob at the shared path. They must stay independent.
    await put('c', 'user:c/d', { 'MEMORY.md': blob('owner-c') })
    await put('c__d', 'user:c__d', { 'MEMORY.md': blob('owner-c__d') })

    const c = await getData('user:c/d', namespaceSlug('user:c/d'))
    const cd = await getData('user:c__d', namespaceSlug('user:c__d'))

    expect(c.content.entries['MEMORY.md']).toBe(blob('owner-c'))
    expect(cd.content.entries['MEMORY.md']).toBe(blob('owner-c__d'))
  })
})

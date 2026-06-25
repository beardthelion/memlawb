/**
 * Quota enforcement. Drives upsert() directly with a non-`local` owner so the
 * per-account aggregate path (quota.ts) runs. Caps come from tests/setup.ts:
 * MAX_NAMESPACE_BYTES=5000, MAX_NAMESPACES_PER_OWNER=3, MAX_OWNER_BYTES=4000,
 * MAX_ENTRIES_PER_NAMESPACE=5. Each test uses a unique owner so the persisted
 * usage records don't bleed across cases.
 */

import { describe, expect, test } from 'bun:test'
import { getData, upsert } from '../src/memory.ts'
import { namespaceSlug } from '../src/namespace.ts'
import { QuotaError } from '../src/quota.ts'

const NOW = '2026-06-24T00:00:00.000Z'

/** A base64 "ciphertext" blob of roughly `n` bytes (content is opaque here). */
function blob(n: number): string {
  return Buffer.from('x'.repeat(n)).toString('base64')
}

function put(owner: string, ns: string, entries: Record<string, string>) {
  return upsert(ns, namespaceSlug(ns), owner, { entries }, NOW)
}

describe('quota enforcement (per-owner)', () => {
  test('per-namespace byte cap → namespace_too_large', async () => {
    const err = await put('qa', 'user:qa', { 'big.md': blob(6000) }).catch(e => e)
    expect(err).toBeInstanceOf(QuotaError)
    expect((err as QuotaError).code).toBe('namespace_too_large')
  })

  test('per-namespace entry count cap → too_many_entries', async () => {
    const entries: Record<string, string> = {}
    for (let i = 0; i < 6; i++) entries[`f${i}.md`] = blob(10)
    const err = await put('qb', 'user:qb', entries).catch(e => e)
    expect(err).toBeInstanceOf(QuotaError)
    expect((err as QuotaError).code).toBe('too_many_entries')
  })

  test('per-owner namespace count cap → too_many_namespaces', async () => {
    await put('qc', 'user:qc', { 'a.md': blob(10) })
    await put('qc', 'user:qc/two', { 'a.md': blob(10) })
    await put('qc', 'user:qc/three', { 'a.md': blob(10) })
    const err = await put('qc', 'user:qc/four', { 'a.md': blob(10) }).catch(e => e)
    expect(err).toBeInstanceOf(QuotaError)
    expect((err as QuotaError).code).toBe('too_many_namespaces')
  })

  test('per-owner total byte cap → owner_quota_exceeded', async () => {
    await put('qd', 'user:qd', { 'a.md': blob(2500) })
    const err = await put('qd', 'user:qd/two', { 'a.md': blob(2500) }).catch(e => e)
    expect(err).toBeInstanceOf(QuotaError)
    expect((err as QuotaError).code).toBe('owner_quota_exceeded')
  })

  test('an over-quota request commits nothing (atomic reject)', async () => {
    await put('qe', 'user:qe', { 'a.md': blob(2500) })
    // This namespace would push the owner over MAX_OWNER_BYTES; it must not land.
    await put('qe', 'user:qe/two', { 'a.md': blob(2500) }).catch(() => {})
    const data = await getData('user:qe/two', namespaceSlug('user:qe/two'))
    expect(Object.keys(data.content.entries)).toHaveLength(0)
  })
})

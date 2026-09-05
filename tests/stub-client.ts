/**
 * A stand-in for MemlawbClient, for tool tests that need a specific server
 * refusal on demand.
 *
 * The denial matrix cannot be driven through the real harness: auth mode, quota
 * caps and the rate limiter are frozen at config import time for the whole test
 * process, so one process cannot produce a 401, a 403, a quota 413 and a 429.
 * The stub raises the exact typed error the client would raise instead.
 *
 * It is only worth anything if it stays honest about the real contract, so it
 * implements the same structural `MemoryClient` the tools take, and the
 * assignment below fails type-check the moment MemlawbClient stops satisfying
 * that type.
 */

import {
  type Erasure,
  type MemlawbClient,
  MemlawbHttpError,
  type PullResult,
  type PushResult,
} from '../client/index.ts'
import type { MemoryClient } from '../src/mcp/tools.ts'

export class StubClient implements MemoryClient {
  /** Plaintext this stub pretends the server holds. */
  entries: Record<string, string> = {}
  /** Thrown by the next call to any method. Set it to render a denial. */
  error: unknown = null
  /**
   * Keys the pretend server refuses, key -> reason. A real 2xx push can store
   * nothing and list the key here, so a stub that always reports every key as
   * uploaded cannot express the case the tools have to render.
   *
   * Every configured key is reported in `skipped`, whether or not this push
   * sent it: the server also lists refused deletion keys, which never appear in
   * `entries`, so a caller must match on the key it sent rather than on
   * `skipped` being non-empty.
   */
  refuse: Record<string, string> = {}
  version = 1
  /** What the pretend server reports about its store. `null` is a server that
   *  reports nothing, which the tools must not read as either answer. */
  erasure: Erasure | null = 'erases'

  private raise() {
    if (this.error) throw this.error
  }

  async push(
    _namespace: string,
    entries: Record<string, string>,
    opts?: { deletions?: string[] },
  ): Promise<PushResult> {
    this.raise()
    const uploaded = Object.keys(entries).filter(k => !(k in this.refuse))
    const skipped = Object.entries(this.refuse).map(([key, reason]) => ({ key, reason }))
    // A refused key is stored nowhere, which is the half of the contract that
    // makes reporting it as saved a lie.
    for (const k of uploaded) this.entries[k] = entries[k] as string
    const deleted = opts?.deletions ?? []
    for (const k of deleted) delete this.entries[k]
    if (uploaded.length || deleted.length) this.version += 1
    return {
      namespace: _namespace,
      version: this.version,
      uploaded,
      unchanged: [],
      deleted,
      skipped,
    }
  }

  async pull(namespace: string): Promise<PullResult> {
    this.raise()
    return { namespace, version: this.version, entries: { ...this.entries } }
  }

  async hashes(_namespace: string): Promise<Record<string, string>> {
    this.raise()
    const out: Record<string, string> = {}
    for (const k of Object.keys(this.entries)) out[k] = `sha256:${'0'.repeat(64)}`
    return out
  }

  async delete(_namespace: string, entryKey: string): Promise<Erasure | null> {
    this.raise()
    delete this.entries[entryKey]
    return this.erasure
  }
}

/** Build the typed refusal the client raises for a non-2xx response. */
export function httpError(
  status: number,
  code: string,
  details?: Record<string, unknown>,
): MemlawbHttpError {
  const body = JSON.stringify({ error: { code, message: code, ...(details ? { details } : {}) } })
  return new MemlawbHttpError(`memlawb ${status}: ${body}`, status, code, details)
}

/**
 * The real client must satisfy the structural type the stub implements. If it
 * drifts (a renamed method, a changed signature), this assignment is a
 * type-check error rather than a stub that silently tests a contract nobody
 * ships.
 */
export const clientSatisfiesMemoryClient: MemoryClient = null as unknown as MemlawbClient

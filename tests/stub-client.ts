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
  version = 1

  private raise() {
    if (this.error) throw this.error
  }

  async push(
    _namespace: string,
    entries: Record<string, string>,
    opts?: { deletions?: string[] },
  ): Promise<PushResult> {
    this.raise()
    const uploaded = Object.keys(entries)
    for (const [k, v] of Object.entries(entries)) this.entries[k] = v
    for (const k of opts?.deletions ?? []) delete this.entries[k]
    this.version += 1
    return {
      namespace: _namespace,
      version: this.version,
      uploaded,
      unchanged: [],
      deleted: opts?.deletions ?? [],
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

  async delete(_namespace: string, entryKey: string): Promise<void> {
    this.raise()
    delete this.entries[entryKey]
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

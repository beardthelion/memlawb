/**
 * Startup preflight for the stdio MCP server.
 *
 * Why this exists: the manifest is cleartext, so a wrong or unexpanded
 * passphrase still lists keys and still saves. That first save leaves a
 * namespace written under two different keys, after which every later pull
 * fails GCM authentication for the CORRECT passphrase too. The damage is done
 * by the first tool call, so the configuration has to be checked before any
 * tool is served, and the process has to exit rather than degrade.
 *
 * It uses the reads the client already has: an authenticated hashes view of the
 * pinned namespace, then a pull when that view reports entries. No new server
 * endpoint, so this works against any deployed memlawb.
 *
 * Startup lives here rather than at server.ts's module top level so it can be
 * driven from a test without spawning a process.
 *
 * Nothing here writes to stdout. stdout is the MCP protocol channel and a
 * single stray byte on it corrupts the stream; the caller writes the returned
 * diagnostic to stderr.
 */

import { MemlawbClient, MemlawbHttpError } from '../../client/index.ts'
import type { ScanMode } from '../../client/secretscan.ts'

export type PreflightResult =
  | { ready: true; client: MemlawbClient; url: string; namespace: string }
  | { ready: false; diagnostic: string }

const DEFAULT_URL = 'http://localhost:8080'
const DEFAULT_NAMESPACE = 'user:me'

type Env = Record<string, string | undefined>

function read(env: Env, name: string): string | undefined {
  const v = env[name]
  return v?.trim() ? v.trim() : undefined
}

/**
 * Any `${...}` in a secret-bearing value, not just the exact literal
 * `${MEMLAWB_PASSPHRASE}`.
 *
 * openclaude substitutes an unset variable reference with its own literal text
 * and registers the server anyway, reporting only a warning, so memlawb
 * receives a non-empty passphrase that is really a template. Matching only the
 * one canonical spelling would miss every config that named the variable
 * something else, and the false-positive risk is close to nil: a passphrase or
 * service key containing `${` is not something `memlawb setup` can produce, and
 * an operator who genuinely wants one can still paste it with the braces
 * separated. This is the only thing standing between the openclaude
 * integration and a mixed-key namespace, and that integration cannot delegate
 * the refusal upstream.
 */
const UNEXPANDED = /\$\{[^}]*\}/

/**
 * Check the configuration against the pinned namespace, returning either a
 * ready client or the one diagnostic that explains what to change.
 */
export async function preflight(env: Env = process.env): Promise<PreflightResult> {
  const url = read(env, 'MEMLAWB_URL') ?? DEFAULT_URL
  const namespace = read(env, 'MEMLAWB_NAMESPACE') ?? DEFAULT_NAMESPACE
  const apiKey = read(env, 'MEMLAWB_API_KEY')
  const passphrase = read(env, 'MEMLAWB_PASSPHRASE')

  // 1. Misexpansion, before anything is sent anywhere.
  for (const name of ['MEMLAWB_PASSPHRASE', 'MEMLAWB_API_KEY'] as const) {
    const value = read(env, name)
    if (value && UNEXPANDED.test(value)) {
      return refuse(
        `${name} still holds an unexpanded variable reference, so this server was launched with template text instead of a value. ` +
          'Set the variable in the environment that launches the MCP server, or put the value itself in the config. ' +
          'Starting like this would write memory under a key nobody can reproduce.',
      )
    }
  }

  // 2. Missing passphrase.
  if (!passphrase) {
    return refuse(
      'MEMLAWB_PASSPHRASE is not set. It is your zero-knowledge encryption key, it never reaches the server, and without it nothing can be read or written. ' +
        'Set it in the environment that launches the MCP server.',
    )
  }

  const client = new MemlawbClient({
    url,
    apiKey,
    passphrase,
    scanMode: (read(env, 'MEMLAWB_SCAN') ?? 'block') as ScanMode,
  })

  // 3, 4, 5. One authenticated read of the pinned namespace separates a
  // transport failure from a refusal, and a rejected key from a namespace this
  // key does not own. They are debugged in completely different places.
  // Built once: an unmapped status can surface from either read, and two
  // copies of the same sentence are two chances for them to drift apart.
  const refuseHttp = (err: MemlawbHttpError) =>
    refuse(
      `the memlawb server at ${url} refused the startup read of "${namespace}" with HTTP ${err.status} (${err.code}). ${err.message}`,
    )

  let checksums: Record<string, string>
  try {
    checksums = await client.hashes(namespace)
  } catch (err) {
    if (!(err instanceof MemlawbHttpError)) {
      return refuse(
        `cannot reach the memlawb server at ${url}: ${(err as Error).message}. ` +
          'This is a transport failure, not a refusal: the server never answered. ' +
          'Check MEMLAWB_URL, name resolution, and whether the server is running.',
      )
    }
    if (err.status === 401) {
      return refuse(
        `the memlawb server at ${url} rejected the service key (HTTP 401). ` +
          'Change MEMLAWB_API_KEY. Your passphrase is not involved here, this is the account key, not the encryption key.',
      )
    }
    if (err.status === 403) {
      // Echoing the namespace is right on stderr, where an operator is reading
      // their own configuration. tools.ts withholds it on a 403 for the
      // opposite reason: that text goes into a model's context.
      return refuse(
        `the memlawb server at ${url} refused namespace "${namespace}" for this service key (HTTP 403). ` +
          'Point MEMLAWB_NAMESPACE at a namespace this key owns, or use the key that owns this one.',
      )
    }
    return refuseHttp(err)
  }

  // 6. Undecryptable namespace. This can only run once the read above reports
  // entries: against an empty namespace nothing exists to authenticate, so a
  // wrong passphrase is indistinguishable from a first-run one and starting is
  // the correct answer. Nothing is lost by it, because the first save is what
  // fixes the key for that namespace.
  if (Object.keys(checksums).length > 0) {
    try {
      await client.pull(namespace)
    } catch (err) {
      if (err instanceof MemlawbHttpError) {
        return refuseHttp(err)
      }
      return refuse(
        `MEMLAWB_PASSPHRASE cannot decrypt the existing entries in namespace "${namespace}". ` +
          'Set the passphrase this namespace was created with. ' +
          'Refusing to start, because saving under a second key would leave the namespace unreadable by the correct passphrase as well.',
      )
    }
  }

  return { ready: true, client, url, namespace }
}

function refuse(diagnostic: string): PreflightResult {
  return { ready: false, diagnostic }
}

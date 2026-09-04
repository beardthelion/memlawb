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
 * A refusal has to name what is wrong, and naming the wrong thing has a cost
 * here that it does not have elsewhere: an operator told to change their
 * passphrase after a transient read failure is one save away from the mixed-key
 * namespace this whole file exists to prevent. So a decryption failure is
 * claimed only when the client says decryption is what failed, and a read that
 * decrypted nothing at all is reported as the server-side drift it is rather
 * than as proof of anything.
 *
 * Startup lives here rather than at server.ts's module top level so it can be
 * driven from a test without spawning a process.
 *
 * Nothing here writes to stdout. stdout is the MCP protocol channel and a
 * single stray byte on it corrupts the stream; the caller writes the returned
 * diagnostic to stderr.
 */

import { MemlawbClient, MemlawbDecryptError, MemlawbHttpError } from '../../client/index.ts'
import type { ScanMode } from '../../client/secretscan.ts'

export type PreflightResult =
  | { ready: true; client: MemlawbClient; url: string; namespace: string; warnings: string[] }
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

const SCAN_MODES: ScanMode[] = ['block', 'warn', 'off']

/**
 * Flatten server-chosen text before it goes into a diagnostic. An entry key
 * comes from the server, diagnostics go to a launcher's log, and a newline plus
 * an ANSI escape in one is a forged log line: this file's own ready line is
 * easy to imitate. Kept short too, since a key can be long and the operator
 * needs the sentence around it.
 */
function oneLine(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  return clean.length > 120 ? `${clean.slice(0, 120)}...` : clean
}

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

  // 3. Scan mode. This used to be cast rather than checked, so a typo built a
  // client whose secret scanner was in no recognized mode, silently weakening
  // the guard that keeps a live credential from being encrypted and stored.
  // Nothing downstream would ever have reported it, so the typo has to be
  // caught here or not at all.
  const scanMode = read(env, 'MEMLAWB_SCAN') ?? 'block'
  if (!SCAN_MODES.includes(scanMode as ScanMode)) {
    return refuse(
      `MEMLAWB_SCAN is set to "${scanMode}", which is not a scan mode. ` +
        `Set it to one of ${SCAN_MODES.join(', ')}, or leave it unset for block. ` +
        'Starting with an unrecognized mode would leave the secret scanner in no mode at all, so a live credential could be encrypted and stored without a word.',
    )
  }

  const client = new MemlawbClient({
    url,
    apiKey,
    passphrase,
    scanMode: scanMode as ScanMode,
  })

  // 4, 5, 6. One authenticated read of the pinned namespace separates a
  // transport failure from a refusal, and a rejected key from a namespace this
  // key does not own. They are debugged in completely different places.
  // Built once: an unmapped status can surface from either read, and two
  // copies of the same sentence are two chances for them to drift apart.
  const refuseHttp = (err: MemlawbHttpError) =>
    refuse(
      `the memlawb server at ${url} refused the startup read of "${namespace}" with HTTP ${err.status} (${err.code}). ${err.message}`,
    )

  // Conditions that are worth telling the operator about but must not stop a
  // supported deployment from serving memory. The caller writes them to stderr.
  const warnings: string[] = []

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

  // 7. Undecryptable namespace. This can only run once the read above reports
  // entries: against an empty namespace nothing exists to authenticate, so a
  // wrong passphrase is indistinguishable from a first-run one and starting is
  // the correct answer. Nothing is lost by it, because the first save is what
  // fixes the key for that namespace.
  const listed = Object.keys(checksums)
  if (listed.length > 0) {
    let decrypted: string[]
    try {
      decrypted = Object.keys((await client.pull(namespace)).entries)
    } catch (err) {
      if (err instanceof MemlawbHttpError) {
        return refuseHttp(err)
      }
      // Only a decryption failure may be reported as one. Everything else that
      // can break this read (a truncated body, a socket dropped mid-transfer, a
      // response that is not the shape the client parses) used to land here and
      // tell the operator their passphrase was wrong; acting on that advice
      // after a transient failure is what creates the mixed-key namespace.
      if (!(err instanceof MemlawbDecryptError)) {
        return refuse(
          `the startup read of namespace "${namespace}" from ${url} failed before anything could be decrypted: ${(err as Error).message}. ` +
            'This is a transport or response failure, not a passphrase problem, so do not change MEMLAWB_PASSPHRASE on the strength of it. ' +
            'Retry, and check the server and the network between you and it.',
        )
      }
      return refuse(
        `MEMLAWB_PASSPHRASE cannot decrypt the existing entries in namespace "${namespace}" (entry "${oneLine(err.entryKey)}": ${oneLine(err.reason)}). ` +
          'Set the passphrase this namespace was created with. ' +
          'Refusing to start, because saving under a second key would leave the namespace unreadable by the correct passphrase as well.',
      )
    }

    // The proof has to be that a decrypt HAPPENED, not that nothing threw.
    // The server drops any manifest key whose blob is missing from both the
    // bodies and the checksums it returns (src/memory.ts, getData), so a fully
    // drifted namespace answers the read with zero entries, no decrypt runs and
    // no error is raised. Treating that as proof declared a wrong passphrase
    // ready, which is this file's worst possible failure.
    //
    // A PARTIAL return is deliberately not refused: at least one entry was
    // decrypted, so the passphrase is proven, and the drift is the server's
    // problem, not the operator's key. Refusing there would take memory away
    // for a condition the passphrase is innocent of, on a deployment where
    // every remaining entry still works. It is reported as a startup warning
    // instead (see `warnings` below).
    if (decrypted.length < listed.length && decrypted.length > 0) {
      warnings.push(
        `the memlawb server at ${url} served ${decrypted.length} of the ${listed.length} entries listed in namespace "${namespace}". ` +
          'The rest are named by the manifest but their stored bodies are gone, and they will be missing from memory until the namespace is restored.',
      )
    }

    if (decrypted.length === 0) {
      return refuse(
        `the memlawb server at ${url} lists ${listed.length} entr${listed.length === 1 ? 'y' : 'ies'} in namespace "${namespace}" but served none of them, ` +
          'so nothing was decrypted and the passphrase could not be checked. ' +
          'This is server-side drift, not a passphrase problem: the manifest names entries whose stored bodies are gone. ' +
          'Restore the namespace from a backup, or point MEMLAWB_NAMESPACE somewhere else. ' +
          'Refusing to start, because a save into this namespace could not be verified against anything.',
      )
    }
  }

  // 8. Whether this deployment enforces the write precondition. Never fatal: a
  // server too old to advertise it is supported, and memory works. But it
  // accepts a save that overwrites a newer entry without saying so, and an
  // operator who thinks the guarantee is in force should hear otherwise once at
  // startup rather than after losing a write. Costs one bodyless GET, paid
  // after every refusal path has already returned.
  try {
    if (!(await client.preconditionEnforced(namespace))) {
      warnings.push(
        `the memlawb server at ${url} does not enforce the write precondition, so a save that overwrites a newer version of an entry is accepted silently. ` +
          'Memory works; upgrade the server to get the stale-write guarantee back.',
      )
    }
  } catch {
    // The reads above already succeeded, so a failure here is a blip on an
    // advisory check. Refusing startup over it would be the tail wagging the
    // dog.
  }

  return { ready: true, client, url, namespace, warnings }
}

function refuse(diagnostic: string): PreflightResult {
  return { ready: false, diagnostic }
}

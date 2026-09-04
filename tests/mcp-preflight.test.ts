/**
 * Startup preflight for `memlawb mcp`.
 *
 * The failure this exists to prevent: a wrong or unexpanded passphrase still
 * lists keys today, because the manifest is cleartext, and still saves. That
 * first save leaves a namespace written with two different keys, after which
 * every later pull fails GCM authentication for the CORRECT passphrase too. So
 * the interesting assertion in the undecryptable case is not "startup was
 * refused", it is "the namespace is still fully readable afterwards".
 *
 * Each defect gets its own control and each control asserts WHICH diagnostic
 * fired, not merely that something did. A preflight that refused every
 * configuration would pass six one-sided refusal tests; `markerOf` below makes
 * that impossible by classifying the diagnostic into exactly one bucket, and
 * the two ready-configuration tests are the negative controls beside them.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemlawbClient } from '../client/index.ts'
import { preflight } from '../src/mcp/startup.ts'

const PASSPHRASE = 'correct horse battery staple'
const WRONG = 'wrong horse battery staple'

let server: ReturnType<typeof Bun.serve>
let url: string

beforeAll(async () => {
  const { handleRequest } = await import('../src/handler.ts')
  server = Bun.serve({ port: 0, fetch: handleRequest })
  url = `http://localhost:${server.port}`
})

afterAll(() => server?.stop(true))

/**
 * Which of the six diagnostics this text is, by a phrase unique to it. Returns
 * 'other' for anything unclassified, so a reworded diagnostic fails loudly
 * rather than quietly matching a neighbour.
 */
function markerOf(text: string): string {
  const table: [string, RegExp][] = [
    ['misexpansion', /unexpanded variable reference/],
    ['missing-passphrase', /MEMLAWB_PASSPHRASE is not set/],
    ['unreachable', /cannot reach the memlawb server/],
    ['rejected-key', /rejected the service key/],
    ['unauthorized-namespace', /refused namespace/],
    ['undecryptable', /cannot decrypt the existing entries/],
  ]
  const hits = table.filter(([, re]) => re.test(text)).map(([name]) => name)
  return hits.length === 1 ? (hits[0] as string) : `other(${hits.join('+') || 'none'})`
}

/** A one-shot server that answers every request the same way. */
function stub(status: number, body: unknown) {
  const hits: string[] = []
  const s = Bun.serve({
    port: 0,
    fetch(req) {
      hits.push(new URL(req.url).pathname)
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  return { url: `http://localhost:${s.port}`, hits, stop: () => s.stop(true) }
}

const envFor = (over: Record<string, string | undefined>) => ({
  MEMLAWB_URL: url,
  MEMLAWB_PASSPHRASE: PASSPHRASE,
  MEMLAWB_NAMESPACE: 'user:me',
  ...over,
})

describe('mcp startup preflight', () => {
  test('no diagnostic ever echoes the passphrase or the service key', async () => {
    // Diagnostics go to stderr, which is exactly what a launcher captures into
    // a log file. The passphrase is the one value that must never leave this
    // process, and a message quoting the thing that failed is the natural way
    // to write one, so this is asserted across every refusal rather than left
    // to review.
    // Built rather than written literally so the file itself carries no
    // template-curly string for the linter to object to.
    const UNEXPANDED_PREFIX = `${'$'}{VAR}`
    const SECRET = 'zzz-passphrase-must-not-appear-zzz'
    const APIKEY = 'zzz-apikey-must-not-appear-zzz'
    const ns = 'user:pf-secrets'
    await new MemlawbClient({ url, passphrase: PASSPHRASE }).push(ns, { 'a.md': 'hi' })
    const denier = stub(401, { error: { code: 'unauthorized' } })
    const forbidder = stub(403, { error: { code: 'forbidden' } })

    const cases: Record<string, string | undefined>[] = [
      { MEMLAWB_PASSPHRASE: `${UNEXPANDED_PREFIX}${SECRET}`, MEMLAWB_API_KEY: APIKEY },
      { MEMLAWB_PASSPHRASE: undefined, MEMLAWB_API_KEY: APIKEY },
      { MEMLAWB_URL: 'http://127.0.0.1:1', MEMLAWB_PASSPHRASE: SECRET, MEMLAWB_API_KEY: APIKEY },
      { MEMLAWB_URL: denier.url, MEMLAWB_PASSPHRASE: SECRET, MEMLAWB_API_KEY: APIKEY },
      { MEMLAWB_URL: forbidder.url, MEMLAWB_PASSPHRASE: SECRET, MEMLAWB_API_KEY: APIKEY },
      { MEMLAWB_NAMESPACE: ns, MEMLAWB_PASSPHRASE: SECRET, MEMLAWB_API_KEY: APIKEY },
    ]
    const seen: string[] = []
    for (const over of cases) {
      const r = await preflight(envFor(over))
      expect(r.ready).toBe(false)
      if (!r.ready) {
        seen.push(markerOf(r.diagnostic))
        expect(`${markerOf(r.diagnostic)} leaks: ${r.diagnostic.includes(SECRET)}`).toBe(
          `${markerOf(r.diagnostic)} leaks: false`,
        )
        expect(r.diagnostic).not.toContain(APIKEY)
      }
    }
    denier.stop()
    forbidder.stop()
    // Positive control: all six refusals were actually exercised. Without this
    // the absence claim would hold just as well over an empty list.
    expect(seen).toEqual([
      'misexpansion',
      'missing-passphrase',
      'unreachable',
      'rejected-key',
      'unauthorized-namespace',
      'undecryptable',
    ])
  })

  test('a correct configuration against an empty namespace is ready', async () => {
    const r = await preflight(envFor({ MEMLAWB_NAMESPACE: 'user:pf-empty' }))
    expect(r.ready).toBe(true)
    if (r.ready) expect(r.namespace).toBe('user:pf-empty')
  })

  test('a correct configuration against a non-empty namespace is ready', async () => {
    const ns = 'user:pf-ready'
    await new MemlawbClient({ url, passphrase: PASSPHRASE }).push(ns, { 'a.md': 'hello' })
    const r = await preflight(envFor({ MEMLAWB_NAMESPACE: ns }))
    expect(r.ready).toBe(true)
  })

  test('an unexpanded variable reference in the passphrase is refused as misexpansion', async () => {
    const s = stub(200, { version: 1, entryChecksums: {} })
    try {
      const r = await preflight(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal is the fixture.
        envFor({ MEMLAWB_URL: s.url, MEMLAWB_PASSPHRASE: '${MEMLAWB_PASSPHRASE}' }),
      )
      expect(r.ready).toBe(false)
      expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('misexpansion')
      // Before any request, not just before any write: the literal must never
      // reach a server that would then hold entries under a key nobody has.
      expect(s.hits).toEqual([])
    } finally {
      s.stop()
    }
  })

  test('an unexpanded reference in the API key is refused as misexpansion', async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal is the fixture.
    const r = await preflight(envFor({ MEMLAWB_API_KEY: '${MEMLAWB_API_KEY}' }))
    expect(r.ready).toBe(false)
    expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('misexpansion')
  })

  test('a missing passphrase is refused as missing, not as misexpansion', async () => {
    const r = await preflight(envFor({ MEMLAWB_PASSPHRASE: '   ' }))
    expect(r.ready).toBe(false)
    expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('missing-passphrase')
  })

  test('an unreachable URL is refused as transport, not as a refusal', async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response('') })
    const deadUrl = `http://localhost:${dead.port}`
    dead.stop(true)
    const r = await preflight(envFor({ MEMLAWB_URL: deadUrl }))
    expect(r.ready).toBe(false)
    expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('unreachable')
  })

  test('a 401 is refused as a rejected key and never as an empty namespace', async () => {
    const s = stub(401, { error: { code: 'unauthorized' } })
    try {
      const r = await preflight(envFor({ MEMLAWB_URL: s.url, MEMLAWB_API_KEY: 'nope' }))
      expect(r.ready).toBe(false)
      expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('rejected-key')
      expect(s.hits.length).toBeGreaterThan(0)
    } finally {
      s.stop()
    }
  })

  test('a 403 is refused as an unauthorized namespace', async () => {
    const s = stub(403, { error: { code: 'forbidden' } })
    try {
      const r = await preflight(
        envFor({ MEMLAWB_URL: s.url, MEMLAWB_NAMESPACE: 'user:someone-else' }),
      )
      expect(r.ready).toBe(false)
      expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('unauthorized-namespace')
    } finally {
      s.stop()
    }
  })

  test('a wrong passphrase is refused, and the namespace stays readable', async () => {
    const ns = 'user:pf-mixed'
    const good = new MemlawbClient({ url, passphrase: PASSPHRASE })
    await good.push(ns, { 'note.md': 'the original plaintext' })

    const r = await preflight(envFor({ MEMLAWB_NAMESPACE: ns, MEMLAWB_PASSPHRASE: WRONG }))
    expect(r.ready).toBe(false)
    expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('undecryptable')

    // The half that matters. A preflight that refused AND wrote would pass the
    // assertion above and still produce the mixed-key namespace R25 describes.
    const back = await new MemlawbClient({ url, passphrase: PASSPHRASE }).pull(ns)
    expect(back.entries).toEqual({ 'note.md': 'the original plaintext' })
  })

  test('a wrong passphrase against an EMPTY namespace is ready, and that is correct', async () => {
    // Nothing exists to authenticate against, so no check can tell a wrong
    // passphrase from a first-run one. Starting is the right answer.
    const r = await preflight(
      envFor({ MEMLAWB_NAMESPACE: 'user:pf-empty-wrong', MEMLAWB_PASSPHRASE: WRONG }),
    )
    expect(r.ready).toBe(true)
  })
})

describe('mcp stdio launch', () => {
  test('a wrong passphrase exits non-zero with nothing on stdout', async () => {
    const ns = 'user:pf-stdio'
    await new MemlawbClient({ url, passphrase: PASSPHRASE }).push(ns, { 'x.md': 'body' })

    // Prove the capture can see stdout at all. Without this an empty capture
    // and a broken capture are indistinguishable.
    const canary = Bun.spawn(['bun', '-e', 'console.log("canary")'], { stdout: 'pipe' })
    expect(await new Response(canary.stdout).text()).toContain('canary')

    // Spawned asynchronously on purpose: the child talks to the Bun.serve above,
    // which runs on THIS event loop, so a synchronous spawn deadlocks.
    const run = Bun.spawn(['bun', 'run', 'bin/memlawb.ts', 'mcp'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        MEMLAWB_URL: url,
        MEMLAWB_NAMESPACE: ns,
        MEMLAWB_PASSPHRASE: WRONG,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, errText, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ])
    expect(out).toBe('')
    expect(markerOf(errText)).toBe('undecryptable')
    expect(code).toBe(1)
  })
})

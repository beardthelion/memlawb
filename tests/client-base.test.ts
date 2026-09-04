/**
 * The client's half of the write precondition.
 *
 * The server refuses a write whose base disagrees with the manifest, but that
 * is worth nothing until a client sends one. The subtlety is which read fills
 * the base: `push` performs its own hashes call immediately before the PUT, so
 * a base taken from there is milliseconds old and guards a window that barely
 * exists. The window that matters is the caller's own turn, so only reads the
 * caller asked for fill the map.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { _reset } from '../src/ratelimit.ts'

let server: ReturnType<typeof Bun.serve>
let base: string
let MemlawbClient: typeof import('../client/index.ts').MemlawbClient
let MemlawbHttpError: typeof import('../client/index.ts').MemlawbHttpError

beforeAll(async () => {
  const { handleRequest } = await import('../src/handler.ts')
  ;({ MemlawbClient, MemlawbHttpError } = await import('../client/index.ts'))
  server = Bun.serve({ port: 0, fetch: handleRequest })
  base = `http://localhost:${server.port}`
})
afterAll(() => server?.stop(true))
afterEach(() => _reset())

const client = () => new MemlawbClient({ url: base, passphrase: 'pw' })

/** A server that answers every request with one canned refusal. */
function denyingServer(status: number, code: string) {
  return Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ error: { code, message: 'nope' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  })
}

describe('base carriage', () => {
  test('a push from a stale read is refused, and the competing write survives', async () => {
    const ns = 'user:cb-stale'
    const a = client()
    const b = client()
    await a.push(ns, { 'a.md': 'v1' })

    // A reads. This is the read its edit is based on.
    await a.pull(ns)
    // B writes underneath it.
    await b.push(ns, { 'a.md': 'from-b' })

    const err = await a.push(ns, { 'a.md': 'from-a' }).catch(e => e)
    expect(err).toBeInstanceOf(MemlawbHttpError)
    expect((err as InstanceType<typeof MemlawbHttpError>).code).toBe('stale_base_version')
    expect((await b.pull(ns)).entries['a.md']).toBe('from-b')
  })

  test('re-reading before the push makes it succeed', async () => {
    const ns = 'user:cb-fresh'
    const a = client()
    const b = client()
    await a.push(ns, { 'a.md': 'v1' })
    await a.pull(ns)
    await b.push(ns, { 'a.md': 'from-b' })

    // Control for the test above: the only difference is this re-read.
    await a.pull(ns)
    await a.push(ns, { 'a.md': 'from-a' })
    expect((await b.pull(ns)).entries['a.md']).toBe('from-a')
  })

  test('a first write into a namespace this client never read still succeeds', async () => {
    const ns = 'user:cb-new'
    await client().push(ns, { 'a.md': 'first' })
    expect((await client().pull(ns)).entries['a.md']).toBe('first')
  })

  test('a delete after a foreign change is refused, and succeeds after a re-read', async () => {
    const ns = 'user:cb-del'
    const a = client()
    const b = client()
    await a.push(ns, { 'a.md': 'v1' })
    await a.pull(ns)
    await b.push(ns, { 'a.md': 'moved' })

    const err = await a.delete(ns, 'a.md').catch(e => e)
    expect(err).toBeInstanceOf(MemlawbHttpError)
    expect((err as InstanceType<typeof MemlawbHttpError>).code).toBe('stale_base_version')

    await a.pull(ns)
    await a.delete(ns, 'a.md')
    expect(Object.keys((await b.pull(ns)).entries)).toEqual([])
  })

  test("push's own pre-flight read does not refresh the base it is meant to check", async () => {
    // The whole point. If the internal hashes call filled the map, the base
    // would always be current and the refusal above could never fire.
    const ns = 'user:cb-preflight'
    const a = client()
    const b = client()
    await a.push(ns, { 'a.md': 'v1' })
    await a.pull(ns)
    await b.push(ns, { 'a.md': 'from-b' })
    // A push whose only read of this namespace since is push's own internal one.
    const err = await a.push(ns, { 'a.md': 'from-a' }).catch(e => e)
    expect(err).toBeInstanceOf(MemlawbHttpError)
  })
})

describe('typed refusals', () => {
  test('each refusal surfaces its status and code', async () => {
    for (const [status, code] of [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [413, 'namespace_too_large'],
      [429, 'rate_limited'],
    ] as const) {
      const s = denyingServer(status, code)
      const c = new MemlawbClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
      const err = await c.pull('user:x').catch(e => e)
      s.stop(true)
      expect(err).toBeInstanceOf(MemlawbHttpError)
      expect((err as InstanceType<typeof MemlawbHttpError>).status).toBe(status)
      expect((err as InstanceType<typeof MemlawbHttpError>).code).toBe(code)
    }
  })

  test('a 404 that is not the server saying empty is an error, not an empty namespace', async () => {
    // The denial-rendered-as-success shape: a wrong URL or a proxy 404 must not
    // reach a caller as a successful read of nothing.
    const s = denyingServer(404, 'not_found')
    const c = new MemlawbClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = await c.pull('user:x').catch(e => e)
    s.stop(true)
    expect(err).toBeInstanceOf(MemlawbHttpError)

    // Control: the server's own empty response still reads as an empty namespace.
    const fresh = await client().pull('user:cb-never-written')
    expect(fresh.entries).toEqual({})
  })

  test('a stale-write refusal carries the base this client actually sent', async () => {
    // KTD3 asks the 409 text to name the base sent alongside the current hash.
    // The server's payload only reports what each key holds NOW, so without
    // this the client is the only party that knows what it wrote against and
    // the information is lost at the throw.
    const a = client()
    const b = client()
    const ns = 'user:cb-sentbase'

    await a.push(ns, { 'x.md': 'one' })
    await a.pull(ns)
    const stale = (await a.hashes(ns))['x.md']
    await b.pull(ns)
    await b.push(ns, { 'x.md': 'two' })

    const err = await a.push(ns, { 'x.md': 'three' }).catch(e => e)
    expect(err).toBeInstanceOf(MemlawbHttpError)
    expect(err.status).toBe(409)
    expect(err.details?.sentBase).toEqual({ 'x.md': stale })
  })

  test('the same rule holds on the hashes path, which has its own guard', async () => {
    // pull and the hashes view each decide what a 404 means, so each needs
    // covering; a fix applied to one is not a fix applied to both.
    const s = denyingServer(404, 'not_found')
    const c = new MemlawbClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = await c.hashes('user:x').catch(e => e)
    s.stop(true)
    expect(err).toBeInstanceOf(MemlawbHttpError)

    // Control: a namespace the real server has never seen still reads as empty.
    expect(await client().hashes('user:cb-hashes-empty')).toEqual({})
  })
})

describe('precondition advertisement', () => {
  test('a server that does not advertise it is reported as not enforcing', async () => {
    const s = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ version: 1, entryChecksums: {}, erasure: 'erases' }), {
          headers: { 'content-type': 'application/json' },
        }),
    })
    const c = new MemlawbClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    expect(await c.preconditionEnforced('user:x')).toBe(false)
    s.stop(true)

    // Control: the real server does advertise it.
    expect(await client().preconditionEnforced('user:cb-adv')).toBe(true)
  })
})

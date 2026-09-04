#!/usr/bin/env bun
/**
 * memlawb CLI — sync a local memory directory to a memlawb server, end-to-end
 * encrypted. Mirrors the openclaude memdir layout (flat .md files + MEMORY.md).
 *
 * Usage:
 *   memlawb push <dir> <namespace>     encrypt + upload changed entries
 *   memlawb pull <dir> <namespace>     download + decrypt into <dir>
 *   memlawb setup <owner> [url]        print the config block + a new passphrase
 *   memlawb serve                      run the server (same as `bun run src/index.ts`)
 *
 * Env (client commands):
 *   MEMLAWB_URL         default http://localhost:8080
 *   MEMLAWB_API_KEY     bearer token (omit for ALLOW_UNAUTHENTICATED self-host)
 *   MEMLAWB_PASSPHRASE  REQUIRED — your zero-knowledge encryption passphrase
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { MemlawbClient } from '../client/index.ts'
import type { ScanMode } from '../client/secretscan.ts'
import { generatePassphrase, renderSetupCard } from '../client/setup.ts'

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[])
  for (const rel of entries) {
    if (rel.endsWith('.md') && rel.split(sep).length <= 3) out.push(rel)
  }
  return out
}

function makeClient(): MemlawbClient {
  const passphrase = process.env.MEMLAWB_PASSPHRASE
  if (!passphrase) {
    console.error('error: MEMLAWB_PASSPHRASE is required (your zero-knowledge key).')
    process.exit(1)
  }
  const scanMode = (process.env.MEMLAWB_SCAN ?? 'block') as ScanMode
  return new MemlawbClient({
    url: process.env.MEMLAWB_URL ?? 'http://localhost:8080',
    apiKey: process.env.MEMLAWB_API_KEY,
    passphrase,
    scanMode,
  })
}

async function cmdPush(dir: string, namespace: string) {
  const client = makeClient()
  const files = await walkMd(dir)
  const entries: Record<string, string> = {}
  for (const rel of files) {
    entries[rel.split(sep).join('/')] = await readFile(join(dir, rel), 'utf8')
  }
  const r = await client.push(namespace, entries)
  console.log(
    `pushed ${namespace}: ${r.uploaded.length} uploaded, ${r.unchanged.length} unchanged → v${r.version}`,
  )
}

async function cmdPull(dir: string, namespace: string) {
  const client = makeClient()
  const r = await client.pull(namespace)
  let n = 0
  for (const [key, plaintext] of Object.entries(r.entries)) {
    const dest = join(dir, ...key.split('/'))
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, plaintext)
    n++
  }
  console.log(`pulled ${namespace} v${r.version}: ${n} files → ${dir}`)
}

/**
 * Print the paste-in block plus a freshly generated passphrase. The passphrase
 * is produced here, on this machine, and shown once: nothing sends it anywhere
 * and nothing can recover it, so the warning is the feature.
 */
function cmdSetup(owner: string, url: string | undefined) {
  const card = renderSetupCard('openclaude', {
    owner,
    url: url ?? process.env.MEMLAWB_URL ?? 'https://memory.gitlawb.com',
    apiKey: process.env.MEMLAWB_API_KEY ?? '<paste your service key here>',
  })
  console.log(card)
  console.log(`Your new passphrase (shown once, back it up now):\n\n  ${generatePassphrase()}\n`)
}

const [cmd, a, b] = process.argv.slice(2)
try {
  switch (cmd) {
    case 'push':
      if (!a || !b) usage()
      await cmdPush(a, b)
      break
    case 'pull':
      if (!a || !b) usage()
      await cmdPull(a, b)
      break
    case 'setup':
      if (!a) usage()
      cmdSetup(a, b)
      break
    case 'mcp':
      // Stdio MCP server. Imported lazily so push/pull/serve don't pay for it.
      await import('../src/mcp/server.ts')
      break
    case 'serve':
      await import('../src/index.ts')
      break
    default:
      usage()
  }
} catch (err) {
  // SecretFoundError and HTTP errors carry actionable messages; print them
  // plainly rather than dumping a stack trace.
  console.error(`error: ${(err as Error).message}`)
  process.exit(1)
}

function usage(): never {
  console.log(
    'usage:\n' +
      '  memlawb push <dir> <namespace>   encrypt + upload changed entries\n' +
      '  memlawb pull <dir> <namespace>   download + decrypt into <dir>\n' +
      '  memlawb setup <owner> [url]      print the paste-in config block + a passphrase\n' +
      '  memlawb mcp                      run the stdio MCP server (memory tools)\n' +
      '  memlawb serve                    run the memlawb server',
  )
  process.exit(1)
}

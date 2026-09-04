/**
 * Prove the PUBLISHED package works, from the tarball, not the working tree.
 *
 * Every failure this catches is invisible in-repo, because in-repo everything
 * runs from source under Bun. Measured before the build existed: a Node
 * consumer importing this package got
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, and the bin died with
 * `/usr/bin/env: 'bun': No such file or directory`, while the whole suite was
 * green. So this script is the test for packaging, and it is only worth what it
 * has been shown to catch: break the build output or rename the bin and it must
 * fail.
 *
 * Run: bun run scripts/packed-tarball-test.ts
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const NODE_DIR = resolve(
  spawnSync('sh', ['-c', 'dirname "$(command -v node)"']).stdout.toString().trim(),
)
/** A PATH with node but deliberately without bun: the consumer machine. */
const NODE_ONLY_PATH = `${NODE_DIR}:/usr/bin:/bin`

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) return console.log(`  ok    ${name}`)
  failures++
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
}
function section(s: string) {
  console.log(`\n${s}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'memlawb-tarball-'))
const consumer = join(scratch, 'consumer')
const dataDir = join(scratch, 'data')
let server: ReturnType<typeof spawn> | undefined

try {
  section('pack and install')
  const packed = spawnSync('bun', ['pm', 'pack', '--destination', scratch], { cwd: ROOT })
  check('bun pm pack succeeds', packed.status === 0, packed.stderr?.toString().slice(0, 300))
  const tgz = spawnSync('sh', ['-c', `ls ${scratch}/*.tgz`])
    .stdout.toString()
    .trim()
  check('a tarball was produced', tgz.endsWith('.tgz'), tgz)

  // The tarball must carry every file the exports map names. Derived from the
  // manifest so this cannot drift away from what consumers actually resolve.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    exports: Record<string, Record<string, string>>
    bin: Record<string, string>
  }
  const listed = spawnSync('tar', ['-tzf', tgz]).stdout.toString()
  const needed = [
    ...Object.values(pkg.exports).flatMap(c => Object.values(c)),
    ...Object.values(pkg.bin),
  ].filter(p => p.startsWith('./dist') || p.startsWith('dist'))
  for (const f of new Set(needed)) {
    const rel = f.replace(/^\.\//, '')
    check(`tarball contains ${rel}`, listed.includes(`package/${rel}`))
  }

  spawnSync('sh', ['-c', `mkdir -p ${consumer} && cd ${consumer} && npm init -y`], {
    stdio: 'ignore',
  })
  const inst = spawnSync('npm', ['install', tgz], { cwd: consumer })
  check(
    'npm install of the tarball succeeds',
    inst.status === 0,
    inst.stderr?.toString().slice(0, 300),
  )

  section('under Node, with bun NOT on PATH')
  const nodeEnv = { ...process.env, PATH: NODE_ONLY_PATH }
  check(
    'bun really is off this PATH (control for every check below)',
    spawnSync('sh', ['-c', 'command -v bun'], { env: nodeEnv }).status !== 0,
  )

  const imported = spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      "import('@gitlawb/memlawb').then(m=>console.log(Object.keys(m).join(','))).catch(e=>{console.error(e.code||e.message);process.exit(1)})",
    ],
    { cwd: consumer, env: nodeEnv },
  )
  const exported = imported.stdout.toString().trim()
  check('the package imports under Node', imported.status === 0, imported.stderr?.toString().trim())
  check('it exposes the client', exported.includes('MemlawbClient'), exported)

  for (const sub of ['crypto', 'secretscan']) {
    const r = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import('@gitlawb/memlawb/${sub}').then(m=>console.log(Object.keys(m).length))`,
      ],
      { cwd: consumer, env: nodeEnv },
    )
    check(
      `subpath ./${sub} resolves under Node`,
      r.status === 0 && Number(r.stdout.toString().trim()) > 0,
    )
  }

  // Checked here, before anything invokes it: a rename must report cleanly
  // rather than crash the run on a missing path, and the consumer repos spawn
  // this name literally.
  check(
    'bin is still named memlawb',
    Object.keys(pkg.bin)[0] === 'memlawb',
    Object.keys(pkg.bin).join(','),
  )
  const bin = join(consumer, 'node_modules', '.bin', 'memlawb')
  if (!existsSync(bin)) {
    check('the installed bin exists at the expected name', false, bin)
    throw new Error('installed bin missing; the checks below cannot run')
  }
  const setup = spawnSync(bin, ['setup', 'tarballuser', 'https://memory.gitlawb.com'], {
    cwd: consumer,
    env: { ...nodeEnv, MEMLAWB_API_KEY: 'mk_tarball' },
  })
  const card = setup.stdout.toString()
  check(
    'the bin runs under Node and prints a card',
    setup.status === 0 && card.includes('mcpServers'),
    setup.stderr?.toString().slice(0, 200),
  )

  const serve = spawnSync(bin, ['serve'], { cwd: consumer, env: nodeEnv })
  check(
    '`serve` refuses on Node, naming Bun',
    serve.status !== 0 && /bun/i.test(serve.stderr.toString() + serve.stdout.toString()),
    serve.stderr.toString().slice(0, 200),
  )

  section('the bin name and env vars the consumer repos hardcode')
  const startupSrc = readFileSync(join(ROOT, 'src/mcp/startup.ts'), 'utf8')
  const read = new Set(startupSrc.match(/MEMLAWB_[A-Z_]+/g) ?? [])
  for (const v of [
    'MEMLAWB_URL',
    'MEMLAWB_API_KEY',
    'MEMLAWB_PASSPHRASE',
    'MEMLAWB_NAMESPACE',
    'MEMLAWB_SCAN',
  ]) {
    check(`${v} is still read by the server`, read.has(v))
  }
  const cardEnv = JSON.parse(card.slice(card.indexOf('{'), card.lastIndexOf('}') + 1)) as {
    mcpServers: { memlawb: { env: Record<string, string> } }
  }
  for (const k of Object.keys(cardEnv.mcpServers.memlawb.env)) {
    check(`the card's ${k} is a variable the server reads`, read.has(k))
  }

  section('the pasted card drives a real save and recall over MCP stdio')
  server = spawn('bun', ['run', join(ROOT, 'src/index.ts')], {
    env: {
      ...process.env,
      ALLOW_UNAUTHENTICATED: 'true',
      STORE: 'fs',
      DATA_DIR: dataDir,
      PORT: '8931',
    },
    stdio: 'ignore',
  })
  await new Promise(r => setTimeout(r, 1200))

  const env = { ...cardEnv.mcpServers.memlawb.env }
  env.MEMLAWB_URL = 'http://localhost:8931' // the only edit: the card names the hosted URL
  env.MEMLAWB_PASSPHRASE = 'tarball test passphrase'

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const transport = new StdioClientTransport({
    command: bin,
    args: ['mcp'],
    env: { ...env, PATH: NODE_ONLY_PATH },
  })
  const mcp = new Client({ name: 'tarball-test', version: '0' })
  await mcp.connect(transport)

  const saved = (await mcp.callTool({
    name: 'memory_save',
    arguments: { key: 'prefs.md', content: 'The user prefers terse answers.' },
  })) as { isError?: boolean; content: { text: string }[] }
  check('memory_save succeeds through the installed bin', !saved.isError, saved.content?.[0]?.text)

  const recalled = (await mcp.callTool({
    name: 'memory_recall',
    arguments: { query: 'how should answers be written' },
  })) as { isError?: boolean; content: { text: string }[] }
  check(
    'memory_recall returns what was saved',
    !recalled.isError && recalled.content[0].text.includes('terse'),
    recalled.content?.[0]?.text?.slice(0, 200),
  )

  const guide = (await mcp.getPrompt({ name: 'memory_guide' })) as {
    messages: { content: { text: string } }[]
  }
  const guideText = guide.messages[0].content.text
  // Markers that exist in skills/memlawb-memory/SKILL.md and not in the inline
  // fallback. A bundle at the wrong depth serves the fallback silently.
  check(
    'the built server serves the real guide, not the fallback',
    guideText.includes('one namespace per codebase') && guideText.length > 3000,
    `${guideText.length} bytes`,
  )

  await mcp.close()

  section('under Bun, the bun condition resolves to source')
  const resolved = spawnSync(
    'bun',
    ['-e', "console.log(await import.meta.resolve('@gitlawb/memlawb'))"],
    { cwd: consumer },
  )
  check(
    'resolves to .ts source, not the build',
    resolved.stdout.toString().trim().endsWith('client/index.ts'),
    resolved.stdout.toString().trim(),
  )
} catch (err) {
  failures++
  console.log(`\n  FAIL  the run stopped early: ${(err as Error).message}`)
} finally {
  server?.kill()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\npacked tarball: OK' : `\npacked tarball: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Bundles memlawb for Node into dist/.
 *
 * The repo runs .ts directly under Bun and needs no build, but a published
 * package does: Node refuses to strip types for anything under node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), with no flag to re-enable it,
 * so an `exports` map pointing at .ts can never resolve for a Node consumer.
 * This script emits the JavaScript that map points at. Declarations come from
 * `tsc --emitDeclarationOnly` (tsconfig.build.json), because Bun's bundler
 * does not emit them.
 *
 * Two things here are load-bearing beyond "run the bundler":
 *
 *   - The CLI output gets a Node shebang. npm's bin shim executes the target's
 *     shebang and one bin name carries one shebang, so `#!/usr/bin/env bun`
 *     makes the installed CLI a hard error on any machine without Bun.
 *   - src/mcp/guide.ts resolves SKILL.md relative to its own file. dist/ sits
 *     at a different depth, so the bundle would silently fall back to the
 *     inline text. We read the guide here, from source, where the walk is
 *     correct, and inline it into the bundle.
 */

import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BunPlugin } from 'bun'
import { FALLBACK, loadMemoryGuide } from '../src/mcp/guide.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = join(root, 'dist')

/** The literal scripts/build.ts rewrites; see the comment on it in guide.ts. */
const GUIDE_SLOT = "const INLINED_GUIDE = ''"

/**
 * Rewrites guide.ts on its way into the bundle so the built MCP server serves
 * SKILL.md's text. Throws rather than degrading: a silent fallback is exactly
 * the failure this exists to prevent.
 */
function inlineGuide(text: string): BunPlugin {
  return {
    name: 'inline-memory-guide',
    setup(build) {
      build.onLoad({ filter: /src[/\\]mcp[/\\]guide\.ts$/ }, async ({ path }) => {
        const src = await Bun.file(path).text()
        if (!src.includes(GUIDE_SLOT)) throw new Error(`build: guide slot not found in ${path}`)
        return {
          contents: src.replace(GUIDE_SLOT, `const INLINED_GUIDE = ${JSON.stringify(text)}`),
          loader: 'ts',
        }
      })
    },
  }
}

function check(result: Awaited<ReturnType<typeof Bun.build>>, what: string) {
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`build: ${what} failed`)
  }
}

const guide = loadMemoryGuide()
if (guide === FALLBACK) throw new Error('build: refusing to inline the fallback guide')

await rm(outdir, { recursive: true, force: true })

// The three client entries the exports map names. Split so `.` and `./crypto`
// share one copy of the crypto module rather than each carrying their own.
check(
  await Bun.build({
    entrypoints: ['client/index.ts', 'client/crypto.ts', 'client/secretscan.ts'].map(p =>
      join(root, p),
    ),
    outdir,
    target: 'node',
    format: 'esm',
    splitting: true,
    naming: { entry: '[name].js' },
  }),
  'client bundle',
)

check(
  await Bun.build({
    entrypoints: [join(root, 'bin/memlawb.ts')],
    outdir,
    target: 'node',
    format: 'esm',
    // Split so the lazy `import()`s in bin/memlawb.ts stay lazy: bundled into
    // one file, the MCP server and the HTTP server would load on every push.
    splitting: true,
    naming: { entry: 'memlawb.js' },
    external: ['@modelcontextprotocol/sdk'],
    plugins: [inlineGuide(guide)],
  }),
  'cli bundle',
)

/**
 * `memlawb serve` boots src/index.ts, which calls Bun.serve (and Bun.S3Client
 * for the s3 store). Under Node that is a bare `ReferenceError: Bun is not
 * defined` from inside a bundle, which tells the user nothing. Name the
 * requirement instead. Guarded on the runtime, so it never fires under Bun,
 * and only on the built artifact, so running from source is untouched.
 */
const NODE_PREAMBLE = `#!/usr/bin/env node
if (typeof Bun === 'undefined' && process.argv[2] === 'serve') {
  console.error(
    'error: \`memlawb serve\` requires the Bun runtime; this is the Node build.\\n' +
      '       Install Bun (https://bun.sh) and run \`bunx @gitlawb/memlawb serve\`,\\n' +
      '       or use the container image. The client commands (push, pull, setup,\\n' +
      '       mcp) run fine on Node.',
  )
  process.exit(1)
}
`

const cli = join(outdir, 'memlawb.js')
const built = await Bun.file(cli).text()
await Bun.write(cli, NODE_PREAMBLE + built.replace(/^#!.*\r?\n/, ''))
await Bun.$`chmod +x ${cli}`.quiet()

const tsc = Bun.spawnSync(['bunx', 'tsc', '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
})
if (tsc.exitCode !== 0) throw new Error('build: declaration emit failed')

console.log(`built ${outdir}`)

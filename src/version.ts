/**
 * The package version, readable from source and from a build.
 *
 * Consumers pin a minimum (zero's enable notice tells an operator to run
 * `memlawb --version`), so this has to work in every shipped form. Importing
 * package.json directly does not: the bundler turns it into a chunk that Node
 * refuses to load as JSON, which broke the Node build while the Bun and binary
 * paths kept working.
 *
 * So the build substitutes the literal below, the same way it inlines the
 * memory guide, and running from source falls back to reading the manifest.
 */

import { readFileSync } from 'node:fs'

/** The literal scripts/build.ts rewrites. Empty means running from source. */
const BUILT_VERSION = ''

export function version(): string {
  if (BUILT_VERSION) return BUILT_VERSION
  const manifest = new URL('../package.json', import.meta.url)
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version
}

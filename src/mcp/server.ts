/**
 * `memlawb mcp` — a stdio MCP server that gives any MCP-capable agent (Claude
 * Code, Cursor, opencode, SDK agents) durable, end-to-end-encrypted memory.
 *
 * It is a thin wrapper over MemlawbClient: the passphrase lives in THIS local
 * process, so encryption/decryption happen here and the remote memlawb server
 * still only ever sees ciphertext. Tool logic is in ./tools.ts; this file just
 * binds it to the MCP protocol.
 *
 * Config (env): MEMLAWB_URL, MEMLAWB_API_KEY, MEMLAWB_PASSPHRASE (required),
 * MEMLAWB_NAMESPACE (default namespace), MEMLAWB_SCAN (block|warn|off).
 * ./startup.ts checks that configuration against the pinned namespace before a
 * single tool is served; nothing here runs on import.
 *
 * IMPORTANT: stdout is the MCP protocol channel — never write logs there. All
 * diagnostics go to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { loadMemoryGuide, SHORT_INSTRUCTIONS } from './guide.ts'
import { preflight } from './startup.ts'
import { makeTools, type ToolResult } from './tools.ts'

const toMcp = (r: ToolResult) => ({
  content: [{ type: 'text' as const, text: r.text }],
  ...(r.isError ? { isError: true } : {}),
})

/**
 * Preflight, then bind the tools and connect the transport. Called by the CLI
 * rather than run on import, so a misconfigured process exits before the
 * transport exists and never half-serves.
 */
export async function main(): Promise<void> {
  const config = await preflight(process.env)
  if (!config.ready) {
    process.stderr.write(`memlawb mcp: ${config.diagnostic}\n`)
    process.exit(1)
  }
  const { client, url, namespace: defaultNamespace, warnings } = config
  // Non-fatal findings from the preflight. Written before the tools are bound
  // so they are the first thing in the launcher's log, and to stderr because
  // stdout belongs to the protocol.
  for (const w of warnings) process.stderr.write(`memlawb mcp: ${w}\n`)
  const tools = makeTools(client, defaultNamespace)

  const server = new McpServer(
    { name: 'memlawb', version: '0.1.0' },
    { instructions: SHORT_INSTRUCTIONS },
  )

  // Full memory-usage protocol, served from the same SKILL.md the Claude Code
  // skill uses — so provider-neutral MCP clients can fetch the discipline too.
  server.registerPrompt(
    'memory_guide',
    {
      title: 'How to use memlawb memory',
      description:
        'The memory-usage protocol: when to recall, what to save, and how to keep memory tidy. Read this once at the start of a session.',
    },
    () => ({
      messages: [{ role: 'user', content: { type: 'text', text: loadMemoryGuide() } }],
    }),
  )

  server.registerTool(
    'memory_save',
    {
      title: 'Save a memory',
      description:
        'Persist a durable fact to encrypted memory. Use for stable facts (user preferences, project decisions, conventions) — not transient chatter. Overwrites the entry at `key`.',
      inputSchema: {
        key: z
          .string()
          .describe('Entry path within the namespace, e.g. "preferences.md" or "project/api.md".'),
        content: z.string().describe('The memory content (markdown).'),
        namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
      },
    },
    async ({ key, content, namespace }) => toMcp(await tools.save(key, content, namespace)),
  )

  server.registerTool(
    'memory_recall',
    {
      title: 'Recall relevant memories',
      description:
        'Return the memories most relevant to a natural-language query, ranked. Call this before answering when prior context might help.',
      inputSchema: {
        query: z.string().describe('What you want to remember about.'),
        namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
        limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5).'),
      },
    },
    async ({ query, namespace, limit }) => toMcp(await tools.recall(query, namespace, limit)),
  )

  server.registerTool(
    'memory_search',
    {
      title: 'Search memories',
      description: 'Literal keyword/substring search over memory keys and content.',
      inputSchema: {
        query: z.string().describe('Substring to search for.'),
        namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
      },
    },
    async ({ query, namespace }) => toMcp(await tools.search(query, namespace)),
  )

  server.registerTool(
    'memory_list',
    {
      title: 'List memory entries',
      description: 'List the entry keys stored in a namespace (no content downloaded).',
      inputSchema: {
        namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
      },
    },
    async ({ namespace }) => toMcp(await tools.list(namespace)),
  )

  server.registerTool(
    'memory_delete',
    {
      title: 'Delete a memory',
      description: 'Remove one entry from a namespace.',
      inputSchema: {
        key: z.string().describe('Entry key to delete.'),
        namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
      },
    },
    async ({ key, namespace }) => toMcp(await tools.delete(key, namespace)),
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`[memlawb mcp] ready • url=${url} • namespace=${defaultNamespace}\n`)
}

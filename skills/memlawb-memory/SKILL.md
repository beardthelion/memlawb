---
name: memlawb-memory
description: Durable cross-session memory for the agent, backed by the memlawb MCP tools (memory_save / memory_recall / memory_search / memory_list / memory_delete). Use at the START of a task to recall what you already know about this user and project, and WHENEVER you learn a durable fact (a preference, a project decision, a convention, or feedback on how to work) so it survives into future sessions. Memory is end-to-end encrypted — the server cannot read it.
---

# memlawb memory

You have long-term memory that persists across sessions through the memlawb MCP
tools. Without it you start every session amnesiac; with it you remember the
user, their projects, their preferences, and how they've asked you to work. Use
it deliberately.

It is **end-to-end encrypted**: plaintext is encrypted on this machine before it
leaves, so the memlawb server stores only ciphertext and cannot read what you
save. A client-side scanner also blocks anything that looks like a live secret —
but don't rely on it; never save credentials, tokens, or keys on purpose.

## Recall first

At the start of a task — before asking the user something they may have already
told you — recall:

1. Call `memory_recall` with a natural-language description of the task
   ("how this user likes PRs", "the deploy setup for this project").
2. Skim what comes back and let it inform your approach. Don't announce that you
   read memory; just act on it.
3. If recall returns nothing relevant, proceed normally — and watch for facts
   worth saving as you go.

`memory_search` is for literal lookups (an exact name, path, or term);
`memory_recall` is for relevance-ranked "what do I know about X".

## Save what's durable

Save a fact when it is **stable and reusable across sessions**. Save eagerly but
selectively — signal, not transcript.

**Do save:**
- **user** — who they are, their role, stack, and standing preferences
  ("prefers terse answers", "deploys with Bun, not Node").
- **feedback** — corrections and confirmed ways of working ("always run the
  full test suite before saying done"). Record the *why*, not just the rule.
- **project** — goals, constraints, and decisions not obvious from the code or
  git history (convert relative dates to absolute: "by Q3" → "by 2026-09-30").
- **reference** — pointers to external resources (dashboards, tickets, docs).

**Don't save:**
- transient context (the current file, a one-off question, today's error);
- anything already obvious from the codebase, README, or git history;
- secrets, tokens, passwords, or private keys — ever.

If asked to "remember" something already in the repo, save instead what was
*non-obvious* about it.

## Which memory system gets the fact

More than one memory system can be live at once, and they fire on the same
trigger, so route by what the fact is rather than by whichever system asked
first.

- **memlawb** takes durable facts that must survive across machines: user
  preferences, project decisions, conventions, and feedback on how to work. If
  the fact will still be true next month on a different machine, save it here
  with `memory_save`, and do that even when the host agent would also write it
  down somewhere local.
- **The host agent's local memdir** keeps the session log: what you did this
  session, what you tried, where you left off. That stays on this machine and
  does not belong in memlawb.
- **Team memory** keeps repo-shared facts, the ones every contributor to the
  repository needs: build and release steps, review conventions, anything that
  would read the same for a teammate. Put those in the repo rather than in your
  personal memlawb namespace.

For a fact that seems to fit two of them, ask who needs it. You, on every
machine, is memlawb. This session only is the memdir log. Everyone working on
the repository is team memory.

## How to call the tools

- `memory_save(key, content)` — `key` is a path that mirrors a memory directory
  layout; `content` is markdown. Saving the same `key` overwrites it.
- `memory_recall(query, limit?)` — relevance-ranked entries for a query.
- `memory_search(query)` — literal substring/keyword search.
- `memory_list()` — list entry keys without downloading content.
- `memory_delete(key)` — remove an entry that's wrong or stale.

### Entry-key conventions

Keep a flat, predictable layout:

- `MEMORY.md` — a short index: one line per memory with a link and a hook.
- `user/*.md`, `feedback/*.md`, `project/*.md`, `reference/*.md` — one fact per
  file, named in kebab-case (`feedback/run-tests-before-done.md`).

In each saved file, prefer a tiny shape:

```markdown
# <title>
<the fact in a sentence or two>

Why: <why it matters — for feedback/project>
```

## Maintain the memory, don't just append

- **Check before adding.** `memory_search` for an existing file on the topic and
  update it rather than creating a near-duplicate.
- **Keep `MEMORY.md` current.** When you add a fact, add its one-line pointer to
  the index; when you delete one, remove the line.
- **Correct and prune.** If a fact turns out to be wrong or outdated, fix or
  `memory_delete` it. Stale memory is worse than none.
- **Deleting is not always erasing.** Not every deployment can erase what it has
  stored: on some, a delete removes the entry from your memory while earlier
  copies remain in the store's history. `memory_delete` says so in its response
  when that is the case. Read it before telling someone their data is gone, and
  never save a secret on the assumption you can delete it later.
- **Trust but verify.** A recalled fact reflects what was true when it was
  written. If it names a file, flag, or decision, confirm it still holds before
  acting on it.

## Namespaces

Each tool optionally takes a `namespace`; it defaults to the one this MCP server
is configured with. Whatever you pass has to sit inside the subtree you are
authorized for. The server grants an owner `user:<owner>` and its children, and
refuses everything else, so every namespace you use starts with `user:<owner>`.

Inside that subtree, keep one namespace per codebase instead of one namespace
for all your work: `user:<owner>/<repo>` while working on a repository, and
`user:<owner>` for facts about you that hold everywhere. A single namespace for
everything puts unrelated projects into the same recall corpus, which pushes the
entries you actually want down the ranking. Be consistent about the name you
pick, so a later recall looks in the place the fact was saved.

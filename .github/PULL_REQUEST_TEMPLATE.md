<!--
Thanks for contributing! Keep the title a Conventional Commit, e.g.
  feat(mcp): add memory_export tool
  fix(quota): account for deletions in per-owner bytes
-->

## What & why

<!-- What does this change and what problem does it solve? Link issues with "Closes #123". -->

## How it was tested

<!-- Commands run, new tests added, manual verification. -->

## Checklist

- [ ] `bun test` passes
- [ ] `bun run type-check` passes
- [ ] `bun run check` (Biome) passes
- [ ] New behavior is covered by tests
- [ ] Docs/README updated if behavior changed
- [ ] Commits signed off (`git commit -s` — DCO)

## Security boundary

- [ ] This change does **not** send plaintext, the passphrase, or a derived key
      to the server (the server stays crypto-blind), **or** it does and I've
      explained why in the description.

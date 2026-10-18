# tokensaver

A Claude Code mod. Clawd, Claude Code's pixel mascot, acts as a token-saving assistant. It:

- trims noisy shell output and pasted logs before they're stored in the conversation;
- warns as the context fills, and compacts in one click;
- warns when the prompt cache has gone cold;
- routes sub-agents to cheaper models.

The README is the user-facing contract. This file is for working on the code.

## Layout

```text
hooks/register.tsx   the only file that touches Claude Code's API: events in, effects out, drawing
src/core/            pure logic, no Claude Code imports
  trim.ts            the output trimmer (the biggest real saver)
  guardian.ts        context-fill levels, cold-cache maths, compaction instructions
  score/route/escalate/tune/delegate/log/savings/tiers.ts   sub-agent routing and its learning
src/runtime/
  assistant.ts       Clawd: trims, guardian, mood and speech, as pure transitions
  session.ts         the router's session controller, as pure transitions
src/ui/              clawd.ts (SVG and glyph art), band.ts (sub-agent strip), view.ts, format.ts, theme.ts
tests/               *.spec.ts run under Vitest; tests/engine/*.test.ts run inside Claude Code
tests/fixtures/      realistic noisy outputs for the trimmer benchmark
scripts/             types sync, build audit, bench, packaging, README pictures
```

Every transition in `src/runtime` is `(state, input) -> { state, effects, reply }`. Keep logic there, where it can be tested fast, and keep `register.tsx` thin.

## Commands

```bash
npm install && npm run types:sync   # once, and again after Claude Code updates
npm run check                       # typecheck, lint, tests + coverage, validate, engine tests, build
npm run bench                       # trimmer savings and speed per fixture (add -- --json for machines)
npm run preview                     # regenerate docs/*.svg from the real renderers
```

`npm run check` must be green before every commit. The `verify-tokensaver` skill in `.claude/skills/` walks through the full verification, including trying the mod live.

## Rules that are easy to break

- **The reach audit.** `scripts/build.mjs` lists every event hooked and every `$` call made. If either changes, the build fails until you update that list *and* the "What it can reach" table in README.md.
- **The trimmer never touches what the user asked to see.** Errors are never folded or cut. File reads, searches and failed results are never trimmed. Output of inspecting commands (`grep`, `cat`, `ls`, `git diff`…) is only trimmed losslessly. Any change to `trim.ts` must keep `tests/bench/trim.spec.ts` passing (floors, kept lines, speed). Paste `npm run bench` before and after into the PR.
- **Validator rules for `register.tsx`.** `$` may only be passed to functions declared at the top level of the module, not to closures inside `register`. Names given to `$.env.get` and `$.command.register` must be string literals.
- **No type assertions (`as`)** beyond `as const`; the lint is strict and type-checked. Booleans are named `is…`/`has…`/`should…`.
- **No runtime dependencies.** Shipped code imports only its own files and `claude-code`.

## Engine behaviours learned the hard way

- `$.session.compact()` is refused inside a `command.run` hook, because it would compact under that command's own turn. Defer it with `$.clock.after(…)`, which is what `/tokensaver compact` does.
- An `Svg` drawn with `isInteractive` renders as a white box in the desktop app. Draw plain images; CSS `@keyframes` inside the SVG still animate there.
- Timers run on `$.clock`, which tests mock, but `Date.now()` is real. Don't compare the two. The idle check reasons from "the timer fired", not from wall-clock differences.
- `npm run types:sync` works because a headless run writes `.claude-plugin/types/` for a `--plugin-dir` folder it *watches*. Since v2.1.299 that needs `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`, which the script sets. It stops at "Not logged in", so nothing is sent and no tokens are spent.
- A hot reload re-runs `register`: module variables reset, while `$.store` and `$.state` survive.
- `session.append` stand-ins in engine tests need Claude Code ≥ 2.1.299. CI pins that version (`CLAUDE_CODE_VERSION` in `.github/workflows`). An older local `claude` fails the four trimmer engine tests; run `claude update`.
- Files may have CRLF line endings on Windows. Prefer the Edit tool over sed or Python for multi-line edits, and never write regexes containing `\u001b` through a shell heredoc.

## Releasing

Bump the same version in `package.json`, `package-lock.json` and `.claude-plugin/plugin.json`, run `npm run check` and `npm run preview`, merge to `main`, then tag `v<version>` and push the tag. The release workflow re-runs every check and publishes the GitHub Release. Users update with `claude plugin marketplace update claude-tokensaver` and `claude plugin update tokensaver@claude-tokensaver`.

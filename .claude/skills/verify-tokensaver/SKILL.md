---
name: verify-tokensaver
description: Verify a change to the tokensaver mod end to end. Runs the static checks, the unit/safety/UI tests, the trimmer efficiency benchmark and the tests inside Claude Code, then tries the mod live in a session. Use after any change to src/, hooks/ or the manifest, before committing, and whenever asked whether tokensaver still works or still saves tokens.
---

# Verify tokensaver

Work through the steps in order and stop at the first failure. Report what ran and what each step said; never report a step you skipped as passed.

## 1. Engine types match the installed Claude Code

```bash
claude --version
npm run types:sync
```

The engine tests need Claude Code 2.1.299 or later, the version CI pins in `.github/workflows/ci.yml`. If the local `claude` is older, say so and suggest `claude update`. The desktop app ships its own newer build under `%APPDATA%\Claude\claude-code\<version>\…\claude.exe`, which can run `plugin test` meanwhile.

## 2. The whole pipeline

```bash
npm run check
```

This runs typecheck, lint, Vitest with an 80% coverage floor, `claude plugin validate --strict`, `claude plugin test .` and the audited build. If the build fails because "calls on $ changed" or "hooks changed", that is the reach audit. Update `scripts/build.mjs` and the README's "What it can reach" table only if the new reach is intended, and say so in the PR.

## 3. The trimmer still saves what it should

```bash
npm run bench
```

Compare against the floors in `tests/bench/trim.spec.ts`. The `errors kept` column must say `yes` on every row. After a change to `src/core/trim.ts`, show the before and after tables. A drop in savings on any fixture needs a reason; a lost error line is a bug.

When the change targets a new kind of noise, add a fixture to `tests/fixtures/outputs.ts` with its `mustKeep` lines and a floor in the bench spec.

## 4. Try it live

Pick one:

- **This session**: the mod hot-reloads if its folder is under the session's mods folder (the plugin-authoring skill explains this).
- **A new session**: start one with `claude --plugin-dir <repo>`, or with `CLAUDE_CODE_PLUGIN_DIRS=<repo>` in the environment. Disable any installed copy first (`claude plugin disable tokensaver@claude-tokensaver`) so two copies don't both load.

Then, in that session:

1. `/tokensaver doctor` should report the mod on, with the display attached.
2. Run something noisy, such as `npm install` in a scratch folder, or `node -e "for(let i=0;i<500;i++)console.log('npm WARN deprecated x@1.0.0')"`. The Bash row should gain a line saying "Clawd ate … tokens", and `/tokensaver` should show non-zero "noise eaten".
3. Run an inspecting command over many similar lines, such as `grep -rn "import" src`. Its output must come back complete, with nothing folded.
4. Run `/tokensaver compact` between turns. Clawd should report the compaction and its freed tokens.

## 5. Report

Write one short block: the Claude Code version, `npm run check` (pass or fail), the bench table, the live checks done, and anything not verified.

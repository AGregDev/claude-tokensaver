# Contributing

Thanks for looking. tokensaver has one goal, token efficiency without hurting result quality, and a change is judged against that.

## Set up

You need Node 22.18 or later and Claude Code v2.1.287 or later on your `PATH`.

```bash
npm install
npm run types:sync
npm run check
```

`npm run types:sync` asks your installed Claude Code to write its mod API declarations into `.claude-plugin/types/`. It runs Claude Code against an empty, throwaway config directory, so it stops before any model request and never spends a token. Run it again after you update Claude Code.

## Layout

```text
.claude-plugin/     plugin.json (the manifest) and marketplace.json
hooks/register.tsx  the hooks module: the only file that touches Claude Code's API
src/core/           scoring, routing, escalation, tuning, the log, savings (pure)
src/runtime/        the session controller: one pure transition per event
src/ui/             the status line and dashboard, as plain styled lines
types/index.d.ts    the mod's $.state contract
tests/              *.spec.ts run under Vitest; engine/*.test.ts run inside Claude Code
scripts/            types sync, build audit, packaging, README pictures
```

The split matters. Everything under `src/` is pure TypeScript with no dependency on Claude Code, so it is tested exhaustively and fast. `hooks/register.tsx` only translates: an event comes in, a controller function returns the next session plus a list of effects, and the hooks module carries the effects out.

Two rules of Claude Code's validator shape that file: `$` may be passed only to a function declared at the top of the hooks module, and the names given to `$.env.get` and `$.command.register` must be string literals.

## Checks

| Command | What it runs |
| :- | :- |
| `npm run typecheck` | `tsc` in strict mode over everything |
| `npm run lint` | ESLint with typescript-eslint's strict, type-checked rules |
| `npm run test:coverage` | Vitest: unit, safety, integration and UI tests, failing under 80% coverage |
| `npm run test:mod` | `claude plugin test .`: the real hooks module, loaded by the real engine |
| `npm run build` | `claude plugin validate --strict`, the reach audit, and staging into `dist/` |
| `npm run check` | All of the above |

Run `npm run check` until it is green before you commit.

## Conventions

- No type assertions (`as`). Data that crosses a boundary, such as the store or the plugin's options, is parsed by a function that returns a checked value. `as const` is fine.
- No runtime dependencies. The mod is loaded from source by Claude Code, and shipped code may import only its own files and `claude-code`. The build enforces this.
- Booleans are named `is…`, `has…`, `should…` and so on.
- A heuristic change comes with a test that shows the case it fixes.

## Changing what the mod can reach

`scripts/build.mjs` holds the list of events the mod hooks and calls it makes, and the build fails when the real list differs. If your change needs a new hook or call:

1. Say why in the pull request.
2. Update the list in `scripts/build.mjs`.
3. Update the "What it can reach" table in `README.md`.

A `tool.check` hook, a network call, a process or a model call would each change what the README promises, so expect that conversation to be a long one.

## Safety tests

`tests/safety/safety.spec.ts` holds the guarantees as properties. If you touch routing, escalation or tuning, check that these still mean something by breaking the guard on purpose and watching the test fail, then put it back.

## Releasing

1. Set the same new version in `package.json` and `.claude-plugin/plugin.json`.
2. Run `npm run check` and `npm run preview` (it regenerates the README pictures).
3. Commit, then tag `v<version>` and push the tag.

The release workflow re-runs every check, packages `dist/tokensaver-<version>.tar.gz` with its SHA-256, and publishes a GitHub Release. People who installed from this repository get the new version with `claude plugin update tokensaver@claude-tokensaver`.

## Listing it in the Claude directory

The repository is already its own marketplace, which is all an install needs. Listing in [Anthropic's directory](https://claude.ai/directory) is a separate, optional step that only the repository owner can take:

1. You need a paid claude.ai plan. On Team and Enterprise, an Owner submits.
2. Run `claude plugin validate . --strict` and fix anything it reports. The portal applies further rules of its own, so read the [pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist) too.
3. Check the [component support table](https://claude.com/docs/plugins/platform-support). tokensaver is a mod, and mods run in Claude Code only, so say so in the listing.
4. Open the developer portal at [claude.ai/directory/manage](https://claude.ai/directory/manage) and follow [Submit a plugin](https://claude.com/docs/plugins/submit).

After it is listed, a new version reaches people once the version you push has been reviewed and published. Never rename the plugin: installs are recorded under its name.

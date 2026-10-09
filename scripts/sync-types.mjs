// Asks the installed Claude Code to write its mod API declarations into
// .claude-plugin/types/ so `tsc` and the editor can type hooks/register.tsx.
//
// Claude Code lays those files whenever it loads a mod from a --plugin-dir
// folder. The load happens before any model request, so this runs it against
// an empty, throwaway config directory: the run stops at "Not logged in" and
// never sends a request or spends a token, on a developer machine or in CI.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const declarations = join(root, '.claude-plugin', 'types', 'claude-code', 'index.d.ts')
const emptyConfig = mkdtempSync(join(tmpdir(), 'tokensaver-types-'))

const env = { ...process.env, CLAUDE_CONFIG_DIR: emptyConfig }

for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
  Reflect.deleteProperty(env, name)
}

// One command string through the shell, so an npm-installed `claude.cmd` resolves on Windows too.
const run = spawnSync(`claude -p types --plugin-dir "${root}"`, {
  cwd: emptyConfig,
  env,
  encoding: 'utf8',
  shell: true,
  timeout: 120_000,
})

rmSync(emptyConfig, { recursive: true, force: true })

if (!existsSync(declarations)) {
  console.error('Claude Code did not write .claude-plugin/types/.')
  console.error('Is it installed (npm install -g @anthropic-ai/claude-code) and v2.1.287 or later?')
  console.error(`${run.stdout ?? ''}${run.stderr ?? ''}`)
  process.exit(1)
}

console.log(readFileSync(declarations, 'utf8').split('\n', 1)[0].replace('// ', ''))

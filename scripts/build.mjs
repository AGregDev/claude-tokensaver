// Builds the installable plugin into dist/tokensaver/ and audits it on the way.
//
// A mod is loaded from source, so there is nothing to compile. What a build
// can do is prove the thing it ships is the thing the README describes:
//   1. Claude Code's own validator accepts it (--strict);
//   2. the events it hooks and the calls it makes are exactly the audited set
//      below, so a change that reaches further fails here until it is reviewed;
//   3. the code it ships imports nothing but its own files and `claude-code`.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist', 'tokensaver')

/** What ships: the plugin, and nothing of the development setup. */
const SHIPPED = [
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  'hooks',
  'commands',
  'src',
  'types',
  'README.md',
  'LICENSE',
]

/** Every event the mod may hook. `tool.check` is absent on purpose: the mod decides no permission. */
const ALLOWED_HOOKS = [
  'agent.spawn',
  'command.run{command=tokensaver}',
  'command.run{command=tokensaver:status|tokensaver:dashboard|tokensaver:doctor|tokensaver:on|tokensaver:off|tokensaver:dry-run|tokensaver:help|tokensaver:compact|tokensaver:trim}',
  'prompt.submit',
  'session.append{door=response}',
  'session.append{door=tool-result}',
  'session.attach',
  'session.compact',
  'session.measure',
  'session.start',
  'tool.call{tool=Agent}',
  'turn.complete',
  'turn.step',
  'ui.close{id=tokensaver}',
  'ui.render{component=AbovePrompt}',
  'ui.render{component=Pane, requestId=tokensaver}',
  'ui.render{component=Spinner}',
  'ui.render{component=ToolUse}',
]

/**
 * Every call the mod may make: display, its own local store, one local file
 * write, folder listings (names only), timers, and a compaction when
 * the person asks for one (or opted in to auto-compact). No `$.agent.spawn`: the
 * mod never starts a sub-agent itself.
 */
const ALLOWED_CALLS = [
  '$.clock.after',
  '$.clock.every',
  '$.command.register',
  '$.env.get',
  '$.fs.list',
  '$.fs.write',
  '$.session.compact',
  '$.session.model',
  '$.session.surfaces',
  '$.state.get',
  '$.state.set',
  '$.store.delete',
  '$.store.get',
  '$.store.set',
  '$.ui.log',
  '$.ui.open',
  '$.ui.resolve',
  '$.ui.status',
  '$.ui.toast',
]

const ALLOWED_ENV_READS = ['NO_COLOR', 'TERM_PROGRAM', 'CLAUDE_CODE_ENTRYPOINT']

const fail = message => {
  console.error(`build: ${message}`)
  process.exit(1)
}

/** The items of one of the validator's "label: a, b, c" lines. */
const listed = (notes, label) => {
  const marker = ` ${label}: `
  const note = notes.find(line => line.includes(marker))

  if (note === undefined) {
    return fail(`the validator reported no "${label}" line`)
  }

  const text = note.slice(note.indexOf(marker) + marker.length)

  // Split on commas outside braces: a matcher such as {component=Pane, requestId=...} has its own.
  return text === 'nothing'
    ? []
    : text.split(/,\s*(?![^{]*\})(?![^(]*\))/).map(item => item.replace(/ \(via [^)]+\)$/, '').trim())
}

const sameSet = (actual, allowed, what) => {
  const added = actual.filter(item => !allowed.includes(item))
  const gone = allowed.filter(item => !actual.includes(item))

  if (added.length > 0 || gone.length > 0) {
    fail(
      [
        `the mod's ${what} changed.`,
        `  new:  ${added.join(', ') || 'none'}`,
        `  gone: ${gone.join(', ') || 'none'}`,
        '  Review the change, then update the list in scripts/build.mjs and the',
        '  "What it can reach" table in README.md.',
      ].join('\n'),
    )
  }
}

const claude = args => spawnSync(`claude ${args}`, { cwd: root, shell: true, encoding: 'utf8' })

// 1. The validator, strictly.
const strict = claude('plugin validate . --strict')

if (strict.status !== 0) {
  fail(`claude plugin validate --strict failed:\n${strict.stdout}${strict.stderr}`)
}

// 2. The audit, from the validator's own reading of the source.
const report = JSON.parse(claude('plugin validate . --json').stdout)
const hooksReport = report.contents.find(entry => entry.type === 'hooks')

if (hooksReport === undefined) {
  fail('the validator found no hooks module')
}

sameSet(listed(hooksReport.notes, 'hooks'), ALLOWED_HOOKS, 'hooked events')
sameSet(listed(hooksReport.notes, 'calls'), ALLOWED_CALLS, 'calls on $')
sameSet(listed(hooksReport.notes, 'env reads'), ALLOWED_ENV_READS, 'environment reads')
sameSet(listed(hooksReport.notes, 'env writes'), [], 'environment writes')

const unguarded = hooksReport.gatingHooks.filter(hook => !hook.hasCatch)

if (unguarded.length > 0) {
  fail(`gating hooks without a .catch: ${unguarded.map(hook => hook.hook).join(', ')}`)
}

// 3. The import graph of what ships.
const sources = dir =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      return sources(path)
    }

    return /\.tsx?$/.test(name) ? [path] : []
  })

for (const file of [...sources(join(root, 'hooks')), ...sources(join(root, 'src'))]) {
  const code = readFileSync(file, 'utf8')

  if (/\bimport\s*\(/.test(code)) {
    fail(`${relative(root, file)} uses import(), which a hooks module may not`)
  }

  for (const [, specifier] of code.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
    if (specifier !== 'claude-code' && !specifier.startsWith('.')) {
      fail(
        `${relative(root, file)} imports "${specifier}": shipped code may import only its own files and claude-code`,
      )
    }
  }
}

// Stage it.
const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

if (plugin.version !== pkg.version) {
  fail(`plugin.json is ${plugin.version} but package.json is ${pkg.version}`)
}

rmSync(join(root, 'dist'), { recursive: true, force: true })

for (const entry of SHIPPED) {
  mkdirSync(dirname(join(out, entry)), { recursive: true })
  cpSync(join(root, entry), join(out, entry), { recursive: true })
}

console.log(`build: tokensaver ${plugin.version} staged in ${relative(root, out)}`)
console.log(`build: ${ALLOWED_HOOKS.length} hooks and ${ALLOWED_CALLS.length} calls, all on the audited list`)

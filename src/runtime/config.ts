import { isRecord } from '../core/log.ts'

/** What the user can switch: the manifest's `userConfig` values, then `/tokensaver` overrides. */
export type Config = {
  isEnabled: boolean
  isDryRun: boolean
  hasReducedMotion: boolean
  hasContextHint: boolean
  hasStatusLine: boolean
}

export const DEFAULT_CONFIG: Config = {
  isEnabled: true,
  isDryRun: false,
  hasReducedMotion: false,
  hasContextHint: true,
  hasStatusLine: true,
}

/** The switches `/tokensaver` changes at run time, kept across sessions. */
export type Overrides = {
  isEnabled?: boolean
  isDryRun?: boolean
  hasReducedMotion?: boolean
}

const flag = (value: unknown, isOnByDefault: boolean): boolean =>
  typeof value === 'boolean' ? value : isOnByDefault

/** Reads the plugin's options as Claude Code hands them to `register`. */
export const parseOptions = (options: Readonly<Record<string, unknown>>): Config => ({
  isEnabled: flag(options['enabled'], DEFAULT_CONFIG.isEnabled),
  isDryRun: flag(options['dryRun'], DEFAULT_CONFIG.isDryRun),
  hasReducedMotion: flag(options['reducedMotion'], DEFAULT_CONFIG.hasReducedMotion),
  hasContextHint: flag(options['contextHint'], DEFAULT_CONFIG.hasContextHint),
  hasStatusLine: flag(options['statusLine'], DEFAULT_CONFIG.hasStatusLine),
})

/** Reads stored overrides, ignoring anything that is not a boolean switch. */
export const parseOverrides = (value: unknown): Overrides => {
  if (!isRecord(value)) {
    return {}
  }

  const { isEnabled, isDryRun, hasReducedMotion } = value

  return {
    ...(typeof isEnabled === 'boolean' ? { isEnabled } : {}),
    ...(typeof isDryRun === 'boolean' ? { isDryRun } : {}),
    ...(typeof hasReducedMotion === 'boolean' ? { hasReducedMotion } : {}),
  }
}

export const applyOverrides = (config: Config, overrides: Overrides): Config => ({
  ...config,
  ...overrides,
})

/** NO_COLOR is honoured when it is set to anything but the empty string (no-color.org). */
export const isNoColor = (value: string | undefined): boolean => value !== undefined && value !== ''

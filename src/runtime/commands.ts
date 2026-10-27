export type Command =
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'doctor' }
  | { kind: 'dashboard' }
  | { kind: 'reset' }
  | { kind: 'enable'; value: boolean }
  /** `value` undefined toggles. */
  | { kind: 'dry-run'; value: boolean | undefined }
  | { kind: 'motion'; value: boolean | undefined }
  /** `value` undefined toggles. */
  | { kind: 'quiet'; value: 'on' | 'off' | 'auto' | undefined }
  | { kind: 'export'; path: string | undefined }
  | { kind: 'unknown'; word: string }

export const DEFAULT_EXPORT_PATH = 'tokensaver-export.json'

export const HELP_TEXT = [
  '/tokensaver              show status',
  '/tokensaver on|off       master switch',
  '/tokensaver dry-run [on|off]   only show what would be delegated',
  '/tokensaver dashboard    open the dashboard pane',
  '/tokensaver motion [on|off]    animations',
  '/tokensaver quiet [on|off|auto]   no pop-ups or glyph art (auto: on in VS Code and Cursor)',
  '/tokensaver export [path]      write the local outcome log as JSON',
  '/tokensaver reset        clear the outcome log and learned thresholds',
  '/tokensaver doctor       what tokensaver knows and what the display reported',
].join('\n')

const switchOf = (word: string | undefined): boolean | undefined => {
  if (word === 'on') {
    return true
  }

  return word === 'off' ? false : undefined
}

/** Parses what follows `/tokensaver`. Nothing typed means `status`. */
export const parseCommand = (args: string): Command => {
  const [first = '', ...rest] = args.trim().split(/\s+/)
  const word = first.toLowerCase()
  const argument = rest.join(' ')

  switch (word) {
    case '':
    case 'status':
      return { kind: 'status' }
    case 'help':
      return { kind: 'help' }
    case 'doctor':
      return { kind: 'doctor' }
    case 'on':
      return { kind: 'enable', value: true }
    case 'off':
      return { kind: 'enable', value: false }
    case 'dashboard':
    case 'pane':
      return { kind: 'dashboard' }
    case 'reset':
      return { kind: 'reset' }
    case 'dry-run':
    case 'dryrun':
      return { kind: 'dry-run', value: switchOf(rest[0]?.toLowerCase()) }
    case 'motion':
      return { kind: 'motion', value: switchOf(rest[0]?.toLowerCase()) }
    case 'quiet':
    case 'subtle': {
      const value = rest[0]?.toLowerCase()

      return { kind: 'quiet', value: value === 'on' || value === 'off' || value === 'auto' ? value : undefined }
    }
    case 'export':
      return { kind: 'export', path: argument === '' ? undefined : argument }
    default:
      return { kind: 'unknown', word: first }
  }
}

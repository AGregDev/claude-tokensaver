/** Bumped whenever what the dashboard draws has changed, so an open pane redraws. */
export type Revision = number

declare module 'claude-code' {
  interface PluginState {
    tokensaver: { revision: Revision }
  }
}

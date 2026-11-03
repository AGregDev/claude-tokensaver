# Changelog

## 0.5.0

- **The caveman voice, built in.** Claude answers first, without ceremony or filler, and keeps every code span, path, number and error exact. The rules are adapted from [Caveman](https://github.com/juliusbrussee/caveman) by Julius Brussee (Apache-2.0) and ride in the system prompt after the cache boundary. On by default; `/tokensaver caveman on|ultra|off`, the pane's **Caveman** button, the `caveman` option, or a prompt that is just `stop caveman` / `normal mode` / `caveman ultra` switches it.
- **Terse sub-agent reports and compaction summaries** while the voice is on, so what they leave in the context is smaller.
- **Measured, not assumed:** tokensaver keeps the average output per finished reply under each voice and shows the comparison in `/tokensaver` and the pane once both have five replies. `/tokensaver doctor` says how many system prompts carried the voice.
- The pane's activity feed marks each kind of event consistently in the terminal and the desktop app.
- Tested on Claude Code 2.1.299 and 2.1.302.
- Release notes now come from this changelog.

## 0.4.0

- Quiet mode for VS Code and Cursor, and group folding in the trimmer.

## 0.3.0

- Clawd, a token-saving assistant: output and paste trimming, context warnings, one-click compaction and the cold-cache coach.

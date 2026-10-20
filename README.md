# Herdr Obsidian

Obsidian companion plugin for [Herdr](https://herdr.dev) — the terminal workspace manager for AI coding agents.

Inspired by and compatible with the workflow of [herdr-vscode for VS Code](https://github.com/XicuM/herdr-vscode).

## Features

- **Live Status Bar Monitor**:
  - Displays currently running, idle, or blocked agents working in this vault's workspace.
  - Distinct visual alerts when an agent becomes **blocked** (waiting for your input or tool approval).
  - Shows a count when multiple agents are blocked to avoid crowding the status bar; full names in tooltip.
- **Agent Switcher (Fuzzy Modal)**:
  - Quickly browse and switch between active agent tabs (`claude`, `codex`, `opencode`, etc.).
  - Blocked agents are automatically sorted to the top.
  - Includes quick actions to open new shell tabs or refresh state.
- **Auto Focus-on-Blocked**:
  - When an agent *transitions* into the `blocked` state, shows an Obsidian notice and opens the terminal view (toggle in settings; off = silent).
  - Pre-existing blocked tabs never notify on startup — only fresh transitions do.
- **Embedded Terminal View**:
  - Tab bar with rename (double-click / right-click), close, keyboard activation, and sticky new-tab button.
  - `Shift+PageUp` / `Shift+PageDown` scroll the remote pane; text selection with `Shift+Arrow` is preserved.
  - Follows Obsidian light/dark theme; font size adjustable in settings.
- **Drag-and-Drop Referencing**:
  - Drag files from Obsidian's file tree or the OS file manager into the terminal to insert paths in the active agent's own mention syntax (`@note.md` for most harnesses, a bare path for Codex); shell tabs get a plain path. Configurable in settings.
  - Drag selected paragraphs or text directly into the terminal with bracketed-paste protection (preventing accidental premature command execution).
  - Resolves internal wikilinks (`[[Note]]`, `[[Note#Heading]]`) to file references.
- **Socket & Polling Sync**:
  - Subscribes directly to Herdr daemon events over the UNIX domain socket (`~/.config/herdr/herdr.sock`), plus periodic polling (interval adjustable in settings, default 2s).
- **Agent Theme Sync**:
  - New tabs launch with `COLORFGBG` set in their environment, matching the terminal light/dark mode, so TUIs like Claude Code pick the right palette on first render (their `auto` detection via OSC 11 through a multiplexed stream is async and can paint the first frames wrong).
  - Already-running agents won't re-detect: run `/theme light` (or `/theme dark`) once inside them to match.

## Commands

- `Herdr: Open Herdr Terminal View`: Show the embedded terminal.
- `Herdr: Switch Agent Conversation`: Open fuzzy switcher to switch active agent tab or run actions.
- `Herdr: Next Agent Conversation`: Cycle to the next agent tab.
- `Herdr: Previous Agent Conversation`: Cycle to the previous agent tab.
- `Herdr: New Agent Conversation`: Choose an agent harness (`agy`, `amp`, `claude`, `codex`, ...) and start it in this vault.
- `Herdr: New Shell Tab`: Open a plain shell tab in the vault's workspace.
- `Herdr: Rename Active Tab`: Rename the currently active tab.
- `Herdr: Focus Vault Workspace`: Direct Herdr daemon to focus this vault's workspace.
- `Herdr: Close Conversation`: Select an active agent tab to close.
- `Herdr: Refresh Herdr Status`: Force refresh of agent snapshot and status bar.
- `Herdr: Diagnose Herdr Connection`: Inspect socket status, workspace matching, and agent state.

## Installation

### Manual Installation
1. Build the plugin:
   ```bash
   npm install
   npm run build
   ```
2. Copy `main.js`, `manifest.json`, and `styles.css` to your Obsidian vault's plugin directory:
   `<Vault>/.obsidian/plugins/herdr-obsidian/`
3. In Obsidian, go to **Settings -> Community Plugins**, reload plugins, and enable **Herdr Obsidian**.

## License

MIT

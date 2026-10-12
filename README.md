# Herdr Companion for Obsidian

Obsidian companion plugin for [Herdr](https://herdr.dev) — the terminal workspace manager for AI coding agents.

Inspired by and compatible with the workflow of [herdr-companion for VS Code](https://github.com/XicuM/herdr-companion).

## Features

- **Live Status Bar Monitor**:
  - Displays currently running, idle, or blocked agents working in this vault's workspace.
  - Distinct visual alerts when an agent becomes **blocked** (waiting for your input or tool approval).
- **Agent Switcher (Fuzzy Modal)**:
  - Quickly browse and switch between active agent tabs (`claude`, `codex`, `opencode`, etc.).
  - Blocked agents are automatically sorted to the top.
  - Includes quick actions to create new agent conversations, new shell tabs, or focus the vault workspace.
- **Auto Focus-on-Blocked**:
  - Automatically notifies you via Obsidian notices when an agent transitions into the `blocked` state.
- **Terminal Integration**:
  - Quickly launch Herdr TUI in your desktop terminal (Alacritty, Kitty, Foot, etc.) or focus the existing Herdr desktop window on Hyprland / Omarchy.
- **Socket & Polling Sync**:
  - Subscribes directly to Herdr daemon events over the UNIX domain socket (`~/.config/herdr/herdr.sock`), with automatic fallback polling.

## Commands

- `Herdr: Switch Agent Conversation`: Open fuzzy switcher to switch active agent tab or run actions.
- `Herdr: Next Agent Conversation`: Cycle to the next agent tab.
- `Herdr: Previous Agent Conversation`: Cycle to the previous agent tab.
- `Herdr: New Agent Conversation`: Choose an agent harness (`claude`, `codex`, `opencode`, `agy`, `gemini`, etc.) and start it in this vault.
- `Herdr: New Shell Tab`: Open a plain shell tab in the vault's workspace.
- `Herdr: Focus Vault Workspace`: Direct Herdr daemon to focus this vault's workspace.
- `Herdr: Open Herdr Terminal Window`: Launch or focus the Herdr TUI.
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
   `<Vault>/.obsidian/plugins/herdr-companion/`
3. In Obsidian, go to **Settings -> Community Plugins**, reload plugins, and enable **Herdr Companion**.

## License

MIT

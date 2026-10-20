# Herdr Obsidian

[![Obsidian 1.0+](https://img.shields.io/badge/Obsidian-1.0%2B-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md)
[![Desktop only](https://img.shields.io/badge/platform-desktop-4B5563)](#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-22C55E)](https://opensource.org/licenses/MIT)

**Herdr, inside Obsidian.** Run, watch, and switch between your Herdr AI coding agents without leaving the vault: embedded terminal tabs, live agent status, focus-on-blocked, and drag-and-drop file references.

Herdr is the terminal workspace manager for coding agents. This plugin puts the same workspace inside Obsidian, so specs, notes, and the agents working on them stay one click apart.

> **Status:** desktop-only, pre-1.0, and not yet in the Obsidian community plugin directory.

## Requirements

- [Obsidian](https://obsidian.md) 1.0+ on desktop
- [Herdr](https://herdr.dev) installed and running (`herdr` on `PATH`)
- A vault that lives in the folder Herdr is working in

## Features

### Embedded terminal

- Native-looking tab bar that mirrors Obsidian's note tabs, including the scooped active-tab curves and theme colors.
- Double-click a tab to rename it, right-click for the context menu, middle-click to close.
- Drag tabs to reorder them; the order is persisted in settings.
- Keyboard navigation: `Enter` / `Space` activates a tab, `←` / `→` moves focus.
- The `+` button opens a new shell tab in the vault workspace. When no tabs exist, the bar offers **New agent** and **New shell** buttons.
- Mouse wheel and `Shift+PageUp` / `Shift+PageDown` scroll the remote pane without disturbing text selection.
- `Ctrl`/`Cmd`+`C` copies a selection, `Ctrl`/`Cmd`+`V` pastes. A real `Ctrl+C` with no selection still sends `SIGINT`.
- File paths and URLs in the buffer are clickable. `Ctrl`/`Cmd`+click opens the link in a new tab.

### Live agent awareness

- Status bar shows blocked and working agents in the current vault workspace, or the number of tabs when none are blocked/working.
- `Herdr: <agent> blocked` appears the moment an agent needs input; the tooltip lists every blocked agent.
- Click the status bar to jump straight to a blocked agent, or open the fuzzy switcher when nothing is blocked.
- Focus-on-blocked only fires on a **transition** into `blocked`; already-blocked agents at startup never trigger a notice.

### Fast switching

- `Herdr: Switch Agent Conversation` opens a fuzzy picker with blocked agents sorted to the top.
- `Herdr: Next Agent Conversation` / `Previous Agent Conversation` cycle tabs from anywhere.
- The picker also exposes **New shell tab**, **Refresh status**, and a **Close conversation** mode.
- All Herdr harnesses are available: `agy`, `amp`, `claude`, `codex`, `copilot`, `cursor`, `devin`, `gemini`, `grok`, `kimi`, `kiro`, `maki`, `opencode`, `pi`, and `qwen`.

### Drag-and-drop references

Drag a file from Obsidian's file explorer or your OS file manager into the terminal, and the plugin inserts the path using the active harness's own mention syntax:

| Harness | No spaces | With spaces |
| --- | --- | --- |
| Claude Code, pi | `@note.md` | `@"my note.md"` |
| Codex | `note.md` | `"my note.md"` |
| opencode, Grok, Antigravity, Copilot | `@note.md` | `@my note.md` |
| Shell / undetected pane | `note.md` | `"my note.md"` |

This mirrors what each harness's own `@` completion inserts. In our testing, only Claude Code turned raw `@path` text into an inline attachment; the others resolved the path by reading it with their file tools. Turn the behavior off in settings to always insert a plain quoted path.

Dragging selected text inserts it directly, and multiline text is wrapped in bracketed paste so it cannot execute prematurely. Internal wikilinks (`[[Note]]`, `[[Note#Heading]]`) resolve to file paths.

### Theme-aware terminal

- `Auto` mode reads Obsidian's CSS variables for background, foreground, cursor, and selection colors.
- The terminal background is also sampled from the rendered buffer, so full-screen TUIs and panes with custom backgrounds stay seamless with the tab bar.
- New tabs created by the plugin launch with `COLORFGBG` set for light or dark mode, so tools that read it (Claude Code, Vim, and friends) paint the right palette on the first frame.
- Already-running agents keep their palette; run `/theme light` or `/theme dark` inside them after switching Obsidian's theme.

## Installation

The plugin is not in the community directory yet. Build it and copy the three runtime files into your vault:

```bash
npm install
npm run build

mkdir -p "<vault>/.obsidian/plugins/herdr-obsidian"
cp main.js manifest.json styles.css "<vault>/.obsidian/plugins/herdr-obsidian/"
```

Then open **Settings → Community plugins**, reload the plugin list, and enable **Herdr Obsidian**.

`main.js` is committed in this repository, so a source checkout without a build step works too.

## Getting started

1. Start Herdr (the plugin also connects to an already-running daemon).
2. Run **Herdr: Open Herdr Terminal View** from the command palette.
3. Create an agent with **Herdr: New Agent Conversation**, or open a shell with **Herdr: New Shell Tab**.
4. Tabs created in Herdr for the same vault workspace appear automatically.

The embedded view attaches to a pane with `herdr terminal session control --takeover`. While it is attached, the Herdr desktop client steps aside; switching tabs or closing the view releases the pane back.

## Commands

| Command | Description |
| --- | --- |
| `Herdr: Open Herdr Terminal View` | Show or focus the embedded terminal. |
| `Herdr: Switch Agent Conversation` | Fuzzy-switch tabs, close a tab, or run quick actions. |
| `Herdr: Next Agent Conversation` | Cycle to the next agent tab. |
| `Herdr: Previous Agent Conversation` | Cycle to the previous agent tab. |
| `Herdr: New Agent Conversation` | Pick a harness (`claude`, `codex`, `opencode`, `agy`, `grok`, …) and start it. |
| `Herdr: New Shell Tab` | Open a plain shell in the vault workspace. |
| `Herdr: Rename Active Tab` | Rename the active Herdr tab. |
| `Herdr: Close Conversation` | Pick a tab to close. |
| `Herdr: Focus Vault Workspace` | Ask Herdr to focus this vault's workspace. |
| `Herdr: Diagnose Herdr Connection` | Show socket path, workspace match, and tab state. |
| `Herdr: Refresh Herdr Status` | Force a snapshot refresh. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Focus on blocked | On | Open the terminal view and show a notice when an agent transitions into `blocked`. |
| Theme mode | Auto | Follow Obsidian, or force the terminal's dark/light palette. |
| Refresh interval | 2 s | Polling fallback; live socket events trigger refreshes regardless. Range 1–30 s. |
| Font size | 14 px | Terminal font size. Range 8–32 px. |
| Prefix dropped files with @ | On | Use each harness's mention syntax for dropped paths. Off inserts a plain quoted path. |
| Herdr session name | *(blank)* | Connect to a named Herdr session instead of the default one. |

## How it works

- **Transport.** The plugin talks JSON-RPC over Herdr's Unix socket: `~/.config/herdr/herdr.sock`, or `~/.config/herdr/sessions/<name>/herdr.sock` for a named session. `HERDR_SOCKET_PATH` overrides both.
- **State.** It subscribes to `pane.*`, `tab.*`, and `workspace.*` events, with periodic polling as a fallback. Only tabs in the vault's workspace are shown.
- **Terminal.** `herdr terminal session control <pane> --takeover` streams terminal frames over a child process; input, resize, scroll, and release are control messages on the same stream.
- **Workspace.** Each vault maps to one Herdr workspace, found by pane `cwd` (with a label fallback) and created on demand.

## Troubleshooting

- **Status bar says `Herdr (offline)`.** Start Herdr, or confirm the binary is on `PATH` and the session name matches.
- **Wrong or missing tabs.** Run **Herdr: Diagnose Herdr Connection**; it prints the socket path, workspace match, and up to ten tabs.
- **`Terminal session taken over by another client`.** Another Herdr client grabbed the pane. Click the tab to re-attach.
- **Named sessions.** Start the daemon with `herdr --session work server`, then set the same name in settings.
- **Agent colors look wrong.** Run `/theme light` or `/theme dark` inside a long-running agent; it only reads the background on startup.

## Development

```bash
npm install
npm run dev    # esbuild watch, inline sourcemap
npm run build  # tsc --noEmit + minified production bundle
```

There is no test suite; `npm run build` is the gate.

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Plugin lifecycle, commands, settings, workspace creation. |
| `src/herdrClient.ts` | Unix-socket JSON-RPC client and event subscription. |
| `src/terminalStream.ts` | `herdr terminal session control` child process and frame handling. |
| `src/terminalView.ts` | xterm.js view, tab bar, input, links, drag-and-drop. |
| `src/terminalTheme.ts` | Obsidian CSS-variable palette and fallbacks. |
| `src/resolver.ts` | Vault workspace and tab mapping, status sorting. |
| `src/notifier.ts` | Transition-only blocked notifications. |
| `src/switcherModal.ts`, `src/renameModal.ts` | Fuzzy switcher and rename dialog. |
| `styles.css` | Native-style tab bar, status dots, full-bleed layout. |

## Credits

Inspired by [herdr-vscode](https://github.com/XicuM/herdr-vscode) and the Herdr workflow. Built with [xterm.js](https://xtermjs.org). Not affiliated with Obsidian or Herdr.

## License

[MIT](https://opensource.org/licenses/MIT)

# Herdr

[![Obsidian 1.7.2+](https://img.shields.io/badge/Obsidian-1.7.2%2B-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md)
[![Desktop and mobile](https://img.shields.io/badge/platform-desktop%20%7C%20mobile-4B5563)](#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-22C55E)](https://opensource.org/licenses/MIT)

> **Unofficial plugin.** This is a community plugin for [herdr](https://herdr.dev). It is not made, endorsed or supported by the herdr authors, nor by Obsidian.

**herdr, inside Obsidian.** Run, watch, and switch between your herdr AI coding agents without leaving the vault: embedded terminal tabs, live agent status, focus-on-blocked, drag-and-drop file references, and, from a phone, your laptop's agents plus a sync of the vault.

herdr is the terminal workspace manager for coding agents. This plugin puts the same workspace inside Obsidian, so specs, notes, and the agents working on them stay one click apart.

> **Status:** pre-1.0, not yet in the Obsidian community plugin directory.

## Screenshots

Notes and agents, side by side — the herdr terminal sits in Obsidian's right sidebar while you edit:

![Herdr terminal in the Obsidian sidebar](docs/herdr-sidebar.png)

<details>
<summary>Full-width terminal view</summary>

![Herdr terminal as a full-width Obsidian tab](docs/herdr-main.png)

</details>

## Requirements

- [Obsidian](https://obsidian.md) 1.7.2+, desktop or mobile.
- [herdr](https://herdr.dev) and [herdr-bridge](https://github.com/XicuM/herdr-mobile) on the machine where your agents run. The plugin talks to herdr only through herdr-bridge.
- On a phone: a way to reach that machine, e.g. [Tailscale](https://tailscale.com).

### Network use

The plugin connects only to the herdr-bridge you configure (by default `127.0.0.1:7788`, this machine), to:

- list and control herdr's tabs and agents, and stream their terminals;
- when herdr-bridge runs on another machine (e.g. your laptop, seen from your phone), sync this vault with that machine's vault of the same name.

It sends nothing anywhere else, and has no telemetry. It doesn't access files outside the vault.

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
- On mobile, a key bar adds `Esc`, `Tab`, `Ctrl+C`, arrows, clear and paste.

### Live agent awareness

- Status bar shows blocked and working agents in the current vault workspace, or the number of tabs when none are blocked/working.
- `Herdr: <agent> blocked` appears the moment an agent needs input; the tooltip lists every blocked agent.
- Click the status bar to jump straight to a blocked agent, or open the fuzzy switcher when nothing is blocked.
- Focus-on-blocked only fires on a **transition** into `blocked`; already-blocked agents at startup never trigger a notice.

### Fast switching

- **Switch agent conversation** opens a fuzzy picker with blocked agents sorted to the top.
- **Next agent conversation** / **Previous agent conversation** cycle tabs from anywhere, in your tab order.
- The picker also exposes **New shell tab**, **Refresh status**, and a **Close conversation** mode.
- All herdr harnesses are available: `agy`, `amp`, `claude`, `codex`, `copilot`, `cursor`, `devin`, `gemini`, `grok`, `kimi`, `kiro`, `maki`, `opencode`, `pi`, and `qwen`.

### Drag-and-drop references

Drag a file from Obsidian's file explorer into the terminal, and the plugin inserts its path using the active harness's own mention syntax:

| Harness | No spaces | With spaces |
| --- | --- | --- |
| Claude Code, pi | `@note.md` | `@"my note.md"` |
| Codex | `note.md` | `"my note.md"` |
| opencode, Grok, Antigravity, Copilot | `@note.md` | `@my note.md` |
| Shell / undetected pane | `note.md` | `"my note.md"` |

This mirrors what each harness's own `@` completion inserts. In our testing, only Claude Code turned raw `@path` text into an inline attachment; the others resolved the path by reading it with their file tools. Turn the behavior off in settings to always insert a plain quoted path.

Dragging selected text inserts it directly, and multiline text is wrapped in bracketed paste so it cannot execute prematurely. Internal wikilinks (`[[Note]]`, `[[Note#Heading]]`) resolve to file paths. Paths are relative to the vault, which is where the agents run.

### Theme-aware terminal

- `Auto` mode reads Obsidian's CSS variables for background, foreground, cursor, and selection colors.
- The terminal background is also sampled from the rendered buffer, so full-screen TUIs and panes with custom backgrounds stay seamless with the tab bar.
- New tabs created by the plugin launch with `COLORFGBG` set for light or dark mode, so tools that read it (Claude Code, Vim, and friends) paint the right palette on the first frame.
- Already-running agents keep their palette; run `/theme light` or `/theme dark` inside them after switching Obsidian's theme.

### Agents open notes in Obsidian

The bridge can push `{"type":"open","vault":"Notes","path":"Note.md","heading":"Intro","line":7}` on `/ws/session`; the plugin then opens that note in Obsidian. Only existing files inside the vault open, and **Let agents open notes** turns it off. On first start with a local bridge, the plugin offers to write `.claude/skills/herdr-open/SKILL.md` (also **Install agent skill**), which tells agents to run `herdr-bridge obsidian open <path>[#heading] [--line N]`. It needs a herdr-bridge with `obsidian open` (herdr-mobile, `POST /api/obsidian/open`); the event carries the vault's name, and other vaults ignore it.

### Vault sync (with a bridge on another machine)

With herdr-bridge on another machine, e.g. your laptop seen from your phone, the plugin syncs this vault with that machine's Obsidian vault of the same name (looked up in Obsidian's vault list there, so any number of vaults work with no setup). Sync from the ribbon icon, the **Sync vault with laptop** command, or automatically on open.

- Each file changed on one side is copied to the other, deletions included (deleted files go to your trash).
- When both sides changed a file, the edit always survives: the laptop's version keeps the path and yours is kept as `<name>.conflict-phone-<time>.<ext>`.
- Hidden folders (`.obsidian` included, so settings and the bridge token stay per device) and build folders are not synced.

With herdr-bridge on this machine there is nothing to sync, so sync doesn't appear at all.

## Installation

The plugin is not in the community directory yet. Build it and copy the three runtime files into your vault:

```bash
npm install
npm run build

mkdir -p "<vault>/.obsidian/plugins/herdr"
cp main.js manifest.json styles.css "<vault>/.obsidian/plugins/herdr/"
```

Then open **Settings → Community plugins**, reload the plugin list, and enable **Herdr**. On a phone, copy the same three files into each vault's `.obsidian/plugins/herdr/` folder.

## Getting started

1. Run herdr-bridge where your agents run, and print its token there: `herdr-bridge --print-token`.
2. In the plugin settings, enter the token. On a phone, also set **Bridge host** to that machine's address (e.g. `100.85.12.34:7788`).
3. Run **Herdr: Open terminal view** from the command palette.
4. Create an agent with **Herdr: New agent conversation**, or open a shell with **Herdr: New shell tab**.
5. Tabs created in herdr for the same vault workspace appear automatically.

The embedded view takes over a pane while it is attached; other herdr clients step aside, and switching tabs or closing the view releases it.

## Commands

| Command | Description |
| --- | --- |
| `Herdr: Open terminal view` | Show or focus the embedded terminal. |
| `Herdr: Switch agent conversation` | Fuzzy-switch tabs, close a tab, or run quick actions. |
| `Herdr: Next agent conversation` | Cycle to the next agent tab. |
| `Herdr: Previous agent conversation` | Cycle to the previous agent tab. |
| `Herdr: New agent conversation` | Pick a harness (`claude`, `codex`, `opencode`, `agy`, `grok`, …) and start it. |
| `Herdr: New shell tab` | Open a plain shell in the vault workspace. |
| `Herdr: Rename active tab` | Rename the active herdr tab. |
| `Herdr: Close conversation` | Pick a tab to close. |
| `Herdr: Focus vault workspace` | Ask herdr to focus this vault's workspace. |
| `Herdr: Diagnose connection` | Show the bridge, workspace match, and tab state. |
| `Herdr: Refresh status` | Force a snapshot refresh. |
| `Herdr: Sync vault with laptop` | Sync now (only with a bridge on another machine). |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Focus on blocked | On | Open the terminal view and show a notice when an agent transitions into `blocked`. |
| Theme mode | Follow Obsidian | Follow Obsidian, or force the terminal's dark/light palette. |
| Font size | 14 px | Terminal font size. Range 8–32 px. |
| Prefix dropped files with @ | On | Use each harness's mention syntax for dropped paths. Off inserts a plain quoted path. |
| Let agents open notes | On | Open notes when an agent asks through herdr-bridge. |
| Bridge host | `127.0.0.1:7788` | `host:port` of herdr-bridge. On a phone, the laptop's address (e.g. its Tailscale IP). |
| Bridge token | — | From `herdr-bridge --print-token`. |
| Sync on open | On | Sync the vault when Obsidian opens (only with a bridge on another machine). |

## How it works

- **Transport.** Everything goes through herdr-bridge: herdr's RPC over HTTP, the terminal over a WebSocket, and live state as snapshots the bridge pushes only when something changed, so the plugin never polls. No Node.js APIs, so the same code runs on desktop and mobile. Requests use herdr's dedicated `herdr-obsidian` session, so agents and workspaces created from Obsidian never clutter the default herdr session or Herdr Mobile.
- **Workspace.** Each vault maps to one herdr workspace, found by pane `cwd` (with a label fallback). With the bridge on this machine it is created on demand; from another machine the plugin only attaches to an existing one, since this vault's path means nothing there.
- **Mobile.** In the background the plugin closes every connection, and reconnects on return. Dropped connections reconnect with backoff.

## Troubleshooting

- **Status bar says `Herdr (offline)`.** Check that herdr-bridge is running at the configured host, and that the token is set.
- **Wrong or missing tabs.** Run **Herdr: Diagnose connection**; it prints the bridge, workspace match, and up to ten tabs.
- **`Terminal session taken over by another client`.** Another herdr client grabbed the pane. Click the tab to re-attach.
- **Agent colors look wrong.** Run `/theme light` or `/theme dark` inside a long-running agent; it only reads the background on startup.

## Development

```bash
npm install
npm run dev    # esbuild watch, inline sourcemap
npm run build  # tsc --noEmit + minified production bundle
npm test       # vitest
npm run lint   # eslint with Obsidian's review rules (eslint-plugin-obsidianmd)
```

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Plugin lifecycle, commands, settings, workspace creation. |
| `src/herdrClient.ts` | herdr-bridge client: RPC, snapshots, live updates. |
| `src/terminalStream.ts` | A pane's terminal over the bridge's WebSocket. |
| `src/terminalView.ts` | xterm.js view, tab bar, input, links, drag-and-drop. |
| `src/terminalTheme.ts` | Obsidian CSS-variable palette and fallbacks. |
| `src/resolver.ts` | Vault workspace and tab mapping, status sorting. |
| `src/notifier.ts` | Transition-only blocked notifications. |
| `src/vaultSync.ts` | On-demand two-way vault sync with the bridge's machine. |
| `src/switcherModal.ts`, `src/renameModal.ts` | Fuzzy switcher and rename dialog. |
| `styles.css` | Native-style tab bar, status dots, full-bleed layout. |

## Credits

Inspired by [herdr-vscode](https://github.com/XicuM/herdr-vscode) and the herdr workflow. Built with [xterm.js](https://xtermjs.org). Not affiliated with Obsidian or herdr.

## License

[MIT](LICENSE)

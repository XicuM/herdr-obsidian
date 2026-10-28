import { App, Editor, MarkdownPreviewView, MarkdownView, Menu, TFile, TFolder, Plugin, normalizePath, PluginSettingTab, SettingDefinitionItem, Notice, FileSystemAdapter, WorkspaceLeaf, Platform, addIcon } from 'obsidian';
import { HerdrClient, Snapshot } from './herdrClient';
import { TerminalStream, TerminalStreamCallbacks } from './terminalStream';
import { VaultSync, SyncLedger, RemoteChange, isSyncablePath } from './vaultSync';
import { AgentResolver, Conversation } from './resolver';
import { HerdrSwitcherModal, HarnessPickerModal, ActionItem } from './switcherModal';
import { HerdrTerminalView, HERDR_VIEW_TYPE } from './terminalView';
import { RenameTabModal } from './renameModal';
import { criticMarkupEditor, renderCriticMarkup, resolveAll, changeAt } from './criticMarkup';

export const HERDR_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" fill="currentColor">
  <path d="M 42.6,11.3 L 45.6,11.2 L 47.2,11.5 L 48.0,11.8 L 44.2,16.0 L 43.3,16.5 L 37.2,17.6 L 31.9,19.4 L 31.5,19.3 L 32.4,17.7 L 33.4,16.1 L 34.8,14.7 L 35.9,13.9 L 36.9,13.2 L 39.6,11.9 L 42.6,11.3 Z" />
  <path d="M 63.5,10.6 L 67.0,10.7 L 70.0,11.3 L 74.1,12.9 L 75.7,13.8 L 77.6,15.0 L 81.5,19.0 L 83.3,21.6 L 84.8,24.9 L 85.8,28.8 L 86.1,31.4 L 85.8,35.6 L 84.7,39.6 L 82.9,43.3 L 80.5,46.3 L 79.1,47.7 L 77.4,48.9 L 75.7,49.9 L 73.8,50.8 L 70.9,51.6 L 67.5,51.8 L 65.7,51.6 L 62.7,50.7 L 60.9,49.6 L 59.2,48.0 L 58.1,46.2 L 57.6,44.1 L 57.7,42.4 L 58.2,40.4 L 60.3,42.0 L 61.6,42.8 L 63.5,43.4 L 65.5,43.7 L 67.1,43.6 L 68.7,43.2 L 70.0,42.5 L 71.4,41.5 L 72.4,40.5 L 73.5,38.9 L 74.4,37.0 L 74.8,34.9 L 74.8,32.8 L 74.4,30.7 L 74.0,29.6 L 72.9,27.7 L 71.2,25.8 L 69.5,24.6 L 67.4,23.6 L 65.6,23.2 L 63.8,23.0 L 61.4,23.2 L 58.8,23.9 L 55.0,25.5 L 53.8,25.4 L 52.4,24.5 L 49.5,21.9 L 48.0,20.2 L 47.7,19.5 L 47.9,18.3 L 49.2,16.7 L 51.5,14.8 L 53.2,13.7 L 56.1,12.2 L 57.9,11.5 L 60.7,10.8 L 63.5,10.6 Z" />
  <path fill-rule="evenodd" d="M 45.0,89.4 L 42.8,86.8 L 41.3,84.3 L 40.4,81.5 L 39.4,75.7 L 38.9,74.3 L 38.3,72.9 L 36.7,70.9 L 34.4,69.2 L 31.9,68.0 L 30.7,67.6 L 28.0,67.1 L 16.5,66.0 L 14.6,65.5 L 12.1,64.6 L 10.8,63.8 L 9.0,62.4 L 7.6,60.4 L 6.5,57.7 L 6.0,54.8 L 6.2,52.7 L 6.7,50.5 L 8.0,47.4 L 9.8,44.1 L 12.3,40.5 L 15.0,37.1 L 19.7,32.2 L 24.6,28.2 L 27.2,26.5 L 31.1,24.4 L 35.3,22.6 L 37.6,21.8 L 39.9,21.2 L 43.5,20.6 L 44.9,23.1 L 47.0,25.5 L 49.6,27.7 L 51.0,28.6 L 52.9,29.5 L 55.2,29.8 L 56.7,29.4 L 60.7,27.6 L 62.8,27.3 L 64.9,27.4 L 66.3,27.6 L 68.0,28.5 L 68.8,29.2 L 69.9,30.9 L 70.6,33.0 L 70.7,34.8 L 70.4,35.9 L 69.7,37.3 L 68.1,38.8 L 66.4,39.6 L 64.5,39.5 L 62.7,38.6 L 59.9,36.1 L 59.1,35.8 L 57.5,35.8 L 56.1,36.4 L 55.1,37.6 L 54.3,38.9 L 53.7,40.6 L 53.4,42.8 L 53.6,45.3 L 54.0,47.2 L 55.4,49.8 L 57.1,51.8 L 59.2,53.4 L 61.6,54.7 L 63.4,55.3 L 66.7,55.8 L 69.4,55.8 L 71.9,55.5 L 74.6,54.8 L 76.9,54.0 L 79.8,52.3 L 82.4,50.2 L 83.9,48.8 L 86.1,46.0 L 87.0,44.5 L 88.6,41.3 L 89.3,39.2 L 89.8,36.9 L 90.1,33.7 L 90.2,30.9 L 89.8,26.4 L 91.2,27.5 L 92.7,29.2 L 93.6,31.1 L 94.0,33.1 L 93.9,34.5 L 93.5,36.0 L 92.0,39.1 L 92.7,41.7 L 92.6,44.2 L 91.7,46.7 L 90.0,49.1 L 87.5,51.4 L 83.0,54.4 L 81.8,56.4 L 79.7,59.3 L 77.2,62.1 L 75.2,63.9 L 70.5,67.2 L 66.5,69.6 L 63.5,71.1 L 57.9,75.9 L 51.0,82.6 L 45.0,89.4 Z M 28.6,33.4 L 27.8,33.8 L 27.4,34.5 L 27.3,35.7 L 27.4,36.4 L 27.6,36.8 L 31.7,39.8 L 32.3,40.3 L 31.7,41.1 L 28.2,43.7 L 27.5,44.5 L 27.3,45.3 L 27.4,46.5 L 28.0,47.2 L 29.0,47.5 L 30.0,47.2 L 31.4,46.3 L 37.4,41.9 L 37.7,41.5 L 37.8,40.3 L 37.6,39.6 L 37.2,39.1 L 33.9,36.3 L 30.3,33.9 L 29.0,33.3 L 28.6,33.4 Z M 43.2,38.5 L 41.3,38.7 L 40.9,38.9 L 40.5,39.5 L 40.3,40.2 L 40.3,40.8 L 40.6,41.5 L 41.1,42.2 L 41.8,42.3 L 43.2,42.4 L 49.9,42.3 L 50.5,40.9 L 50.5,40.2 L 50.3,39.5 L 49.7,38.9 L 48.9,38.6 L 47.4,38.5 L 43.2,38.5 Z" />
</svg>`;

export const HERDR_OBSIDIAN_SESSION = 'herdr-obsidian';
/** herdr-bridge on this machine, where the desktop app finds it unless told otherwise. */
const LOCAL_BRIDGE = '127.0.0.1:7788';

export interface HerdrSettings {
  themeMode: 'auto' | 'dark' | 'light';
  fontSize: number;
  sendToAgentMenu: boolean;
  tabOrder?: string[];
  bridgeHost: string;
  bridgeToken: string;
  autoSyncOnOpen: boolean;
  syncLedger?: SyncLedger;
  allowAgentOpen: boolean;
  agentSkillOffered: boolean;
}

const DEFAULT_SETTINGS: HerdrSettings = {
  themeMode: 'auto', // Follow Obsidian theme
  fontSize: 16,
  sendToAgentMenu: true,
  tabOrder: [],
  bridgeHost: '',
  bridgeToken: '',
  autoSyncOnOpen: true,
  syncLedger: {},
  allowAgentOpen: true,
  agentSkillOffered: false
};

/** Where agents look for project skills; Claude Code only reads .claude/skills, so that one links here. */
const AGENT_SKILL_DIR = '.agents/skills/herdr-open';
const CLAUDE_SKILL_LINK = '.claude/skills/herdr-open';
const AGENT_SKILL = `---
name: herdr-open
description: Show a note, heading or line to the user in their Obsidian window, or suggest edits to their notes. Use when pointing at a note instead of pasting it, or when proposing changes to text.
---

Run \`herdr-bridge obsidian open <path>[#heading] [--line N]\`, with the path relative to your working directory.
Use it to show what you found or changed. Never use \`mv\` to rename notes: it breaks wikilinks.

To suggest a change to the user's text instead of editing it, write CriticMarkup in the note: \`{++added++}\`, \`{--deleted--}\`, \`{~~old~>new~~}\`, \`{==highlighted==}\`, \`{>>comment<<}\`.
The user accepts or rejects each one in Obsidian. Leave the surrounding text untouched.
`;

export default class HerdrPlugin extends Plugin {
  settings: HerdrSettings = DEFAULT_SETTINGS;
  private client!: HerdrClient;
  private resolver!: AgentResolver;
  private unsubscribeEvents: (() => void) | null = null;
  /** Bumped on each disconnect, so a subscription that resolves afterwards knows it is stale. */
  private connection = 0;
  private lastAppearance: 'light' | 'dark' | null = null;
  private refreshRunning: Promise<void> = Promise.resolve();
  private refreshQueued: Promise<void> | null = null;
  private syncRunning: Promise<void> = Promise.resolve();
  private syncQueued: { done: Promise<void>; manual: boolean; changes: Map<string, RemoteChange> | null } | null = null;
  /** Files edited on the phone since the last check, pushed once the edits settle. */
  private localEdits = new Set<string>();
  private localEditsTimer = 0;
  /** The conversations last rendered, to skip re-rendering when a snapshot changed nothing shown. */
  private renderedKey = '';
  private convByTab = new Map<string, Conversation>();
  private currentActiveTabId?: string;
  private singletonWorkspaceId?: string;

  public bridgeHost(): string {
    return this.settings.bridgeHost || LOCAL_BRIDGE;
  }

  /**
   * Whether herdr-bridge runs on another machine (e.g. the laptop, seen from a phone). Only then is
   * there a vault copy to sync with: on this machine, the agents already work in this very folder.
   */
  public isRemoteBridge(): boolean {
    const host = this.bridgeHost();
    let hostname = host;
    try {
      hostname = new URL(host.includes('://') ? host : `http://${host}`).hostname;
    } catch {
      // Not a URL: compare the raw value.
    }
    return !(hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.'));
  }

  public createTerminalStream(paneId: string, callbacks: TerminalStreamCallbacks) {
    return new TerminalStream(this.bridgeHost(), this.settings.bridgeToken, HERDR_OBSIDIAN_SESSION, paneId, callbacks);
  }

  async onload() {
    await this.loadSettings();

    // Register Herdr icon in Obsidian UI
    addIcon('herdr', HERDR_ICON);

    // Register Terminal View in Obsidian UI
    this.registerView(
      HERDR_VIEW_TYPE,
      (leaf) => new HerdrTerminalView(leaf, this)
    );

    this.addRibbonIcon('herdr', 'Open agent terminal', () => void this.activateTerminalView());

    // Commands
    this.addCommand({
      id: 'open-view',
      name: 'Open terminal view',
      callback: () => void this.activateTerminalView()
    });

    this.addCommand({
      id: 'switch-conversation',
      name: 'Switch terminal tab',
      callback: () => this.pickConversation('switch')
    });

    this.addCommand({
      id: 'switch-next',
      name: 'Next terminal tab',
      callback: () => this.switchNext()
    });

    this.addCommand({
      id: 'switch-prev',
      name: 'Previous terminal tab',
      callback: () => this.switchPrev()
    });

    this.addCommand({
      id: 'new-conversation',
      name: 'New agent conversation',
      callback: () => this.promptNewConversation()
    });

    this.addCommand({
      id: 'new-shell-tab',
      name: 'New terminal tab',
      callback: () => void this.newShellTab()
    });

    this.addCommand({
      id: 'rename-current-tab',
      name: 'Rename active tab',
      callback: () => {
        const convs = this.getConversations();
        const active = convs.find((c) => c.tab_id === this.currentActiveTabId) || convs[0];
        if (active) {
          this.promptRename(active);
        } else {
          new Notice('No active tab to rename.');
        }
      }
    });

    this.addCommand({
      id: 'close-conversation',
      name: 'Close conversation',
      callback: () => this.pickConversation('close')
    });

    this.addCommand({
      id: 'focus-workspace',
      name: 'Focus vault workspace',
      callback: () => void this.focusVaultWorkspace()
    });

    this.addCommand({
      id: 'diagnose-connection',
      name: 'Diagnose connection',
      callback: () => void this.diagnoseConnection()
    });

    this.addCommand({
      id: 'refresh-status',
      name: 'Refresh status',
      callback: () => void this.refreshState()
    });

    // Vault sync only exists with a bridge on another machine; it shows and hides with the setting.
    this.addCommand({
      id: 'sync-vault',
      name: 'Sync vault with laptop',
      checkCallback: (checking) => {
        if (!this.isRemoteBridge()) return false;
        if (!checking) void this.syncVault(true);
        return true;
      }
    });

    this.addCommand({
      id: 'install-agent-skill',
      name: 'Install agent skill (let agents open notes)',
      callback: () => void this.installAgentSkill()
    });

    // CriticMarkup suggestions: rendered in Live Preview and Reading view, resolved from the editor.
    this.registerEditorExtension(criticMarkupEditor);
    this.registerMarkdownPostProcessor(renderCriticMarkup);
    for (const accept of [true, false]) {
      this.addCommand({
        id: accept ? 'accept-suggestion' : 'reject-suggestion',
        name: accept ? 'Accept suggestion (selection or at cursor)' : 'Reject suggestion (selection or at cursor)',
        editorCallback: (editor) => {
          if (editor.somethingSelected()) {
            editor.replaceSelection(resolveAll(editor.getSelection(), accept));
            return;
          }
          const change = changeAt(editor.getValue(), editor.posToOffset(editor.getCursor()));
          if (!change) new Notice('No suggestion here.');
          else editor.replaceRange(change.replacement(accept), editor.offsetToPos(change.from), editor.offsetToPos(change.to));
        }
      });
    }

    // Point the active agent tab at the selected lines, so it knows where the text lives.
    this.addCommand({
      id: 'send-selection',
      name: 'Send selection to agent',
      checkCallback: (checking) => {
        const active = this.app.workspace.activeEditor;
        const ref = this.readingSelectionRef() || (active?.editor && active.file ? editorRef(active.editor, active.file) : null);
        if (!ref) return false;
        if (!checking) this.sendReference(ref);
        return true;
      }
    });
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
      const ref = info.file ? editorRef(editor, info.file) : null;
      if (ref) this.addSendItem(menu, ref);
    }));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      const isFolder = file instanceof TFolder;
      const p = isFolder && !file.path.endsWith('/') ? `${file.path}/` : file.path;
      this.addSendItem(menu, { path: p });
    }));
    // Reading view leaves selections to Electron's native Copy menu; replace it with ours.
    this.registerDomEvent(document, 'contextmenu', (e) => {
      if (!this.settings.sendToAgentMenu) return;
      const ref = this.readingSelectionRef();
      if (!ref || e.defaultPrevented) return;
      e.preventDefault();
      const text = window.getSelection()?.toString() ?? '';
      const menu = new Menu().addItem((item) => item
        .setTitle('Copy')
        .setIcon('lucide-copy')
        .setSection('clipboard')
        .onClick(() => void navigator.clipboard.writeText(text)));
      this.addSendItem(menu, ref);
      menu.showAtMouseEvent(e);
    });

    this.addSettingTab(new HerdrSettingTab(this.app, this));

    this.connect();

    if (Platform.isMobile) {
      // In the background a phone streams nothing; it reconnects on return.
      this.registerDomEvent(document, 'visibilitychange', () => {
        const view = this.getTerminalView();
        if (document.hidden) {
          this.disconnect();
          view?.suspend();
        } else {
          this.connect();
          view?.resume();
        }
      });
    }

    // Obsidian's light/dark into the machine's OpenCode: the same attributes the terminal palette
    // watches, sent to the bridge, which sets them in OpenCode's cli.json (which it hot-reloads).
    const themeObserver = new MutationObserver(() => void this.sendAppearance());
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    this.register(() => themeObserver.disconnect());

    // Registered once the vault is loaded: loading it raises a `create` for every file.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', (f) => this.localEdited(f.path)));
      this.registerEvent(this.app.vault.on('modify', (f) => this.localEdited(f.path)));
      this.registerEvent(this.app.vault.on('delete', (f) => this.localEdited(f.path)));
      this.registerEvent(this.app.vault.on('rename', (f, oldPath) => {
        this.localEdited(oldPath);
        this.localEdited(f.path);
      }));
    });
    this.register(() => window.clearTimeout(this.localEditsTimer));
  }

  onunload() {
    this.disconnect();
  }

  /** (Re)connects to Herdr with the current settings: a new client, live updates, a fresh snapshot. */
  public connect() {
    this.disconnect();
    this.client = new HerdrClient({ host: this.bridgeHost(), token: this.settings.bridgeToken, session: HERDR_OBSIDIAN_SESSION });
    this.resolver = new AgentResolver(this.client);
    // The bridge pushes every new snapshot, so nothing polls.
    this.subscribeEvents();
    void this.refreshState();
    void this.sendAppearance();
  }

  /** The terminal's effective light/dark: themeMode's choice, or Obsidian's own theme in `auto`. */
  public effectiveAppearance(): 'light' | 'dark' {
    const mode = this.settings.themeMode;
    return mode === 'light' || (mode === 'auto' && document.body.classList.contains('theme-light')) ? 'light' : 'dark';
  }

  /**
   * Tells the bridge the appearance, so this machine's OpenCode themes itself to match. The bridge
   * sets it in OpenCode's cli.json, which OpenCode reloads while it runs. Sent once per change; an
   * old bridge (404) or a dead connection just retries on the next change or reconnect.
   */
  public async sendAppearance(): Promise<void> {
    if (!this.client.isConfigured()) return;
    const mode = this.effectiveAppearance();
    if (mode === this.lastAppearance) return;
    try {
      await this.client.setAppearance(mode);
      this.lastAppearance = mode;
    } catch {
      // An old bridge or a dead connection: the next change or reconnect retries.
    }
  }

  private disconnect() {
    this.connection++;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
  }

  public getVaultFolderPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return this.app.vault.getName();
  }

  /**
   * The vault's herdr workspace, created for its folder if missing. Only with the bridge on this
   * machine: another machine (the laptop, from a phone) can't open this vault's path, so there it
   * only attaches to an existing workspace.
   */
  private async findVaultWorkspace(snapshot: Snapshot): Promise<string | undefined> {
    const folder = this.getVaultFolderPath();
    if (!this.isRemoteBridge() && this.app.vault.adapter instanceof FileSystemAdapter) {
      return this.resolver.ensureWorkspace(folder, snapshot);
    }
    return this.resolver.findWorkspaceForFolder(snapshot, folder)?.workspace_id;
  }

  public getSessionName(): string {
    return HERDR_OBSIDIAN_SESSION;
  }

  public getConversations(): Conversation[] {
    const list = [...this.convByTab.values()];
    const order = this.settings.tabOrder;
    if (order && order.length > 0) {
      const orderMap = new Map(order.map((id, idx) => [id, idx]));
      list.sort((a, b) => {
        const orderA = orderMap.get(a.tab_id) ?? 9999;
        const orderB = orderMap.get(b.tab_id) ?? 9999;
        return orderA - orderB;
      });
    }
    return list;
  }

  public async reorderTab(fromTabId: string, targetTabId: string, insertBefore: boolean): Promise<void> {
    if (fromTabId === targetTabId) return;
    const currentList = this.getConversations().map((c) => c.tab_id);
    const fromIdx = currentList.indexOf(fromTabId);
    if (fromIdx === -1) return;
    currentList.splice(fromIdx, 1);

    let targetIdx = currentList.indexOf(targetTabId);
    if (targetIdx === -1) {
      currentList.push(fromTabId);
    } else {
      if (!insertBefore) {
        targetIdx += 1;
      }
      currentList.splice(targetIdx, 0, fromTabId);
    }

    this.settings.tabOrder = currentList;
    await this.saveSettings();
    this.getTerminalView()?.renderTabs();
  }

  public async activateTerminalView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(HERDR_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: HERDR_VIEW_TYPE,
          active: true
        });
      }
    }

    if (leaf) {
      await workspace.revealLeaf(leaf);
    }
  }

  private addSendItem(menu: Menu, ref: LineRef) {
    if (!this.settings.sendToAgentMenu) return;
    menu.addItem((item) => item
      .setTitle('Send to agent')
      .setIcon('terminal')
      .setSection('clipboard')
      .onClick(() => this.sendReference(ref)));
  }

  private sendReference(ref: LineRef) {
    const view = this.getTerminalView();
    if (view) view.sendReference(ref.path, ref.start, ref.end);
    else new Notice('Open the herdr terminal view first.');
  }

  /** The source lines behind a Reading view selection, via the blocks it spans. */
  private readingSelectionRef(): LineRef | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return null;
    const range = sel.getRangeAt(0);
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view as MarkdownView;
      if (view.getMode() !== 'preview' || !view.file || !view.previewMode.containerEl.contains(range.startContainer)) continue;
      // Obsidian internals: the renderer maps a rendered block back to its source lines.
      const renderer = (view.previewMode as MarkdownPreviewView & {
        renderer?: { getSectionInfo(el: HTMLElement): { lineStart: number; lineEnd: number } | null };
      }).renderer;
      const section = (node: Node) => {
        for (let el = node.instanceOf(HTMLElement) ? node : node.parentElement; el; el = el.parentElement) {
          const info = renderer?.getSectionInfo(el);
          if (info) return info;
        }
        return null;
      };
      const first = section(range.startContainer);
      const last = section(range.endContainer);
      return first && last ? { path: view.file.path, start: first.lineStart + 1, end: last.lineEnd + 1 } : null;
    }
    return null;
  }

  public getTerminalView(): HerdrTerminalView | null {
    const leaves = this.app.workspace.getLeavesOfType(HERDR_VIEW_TYPE);
    if (leaves.length > 0 && leaves[0].view instanceof HerdrTerminalView) {
      return leaves[0].view;
    }
    return null;
  }

  /** An agent asked to show a note. Only existing files inside the vault open: nothing is created. */
  private async openForAgent(path: string, heading?: string, line?: number) {
    if (!this.settings.allowAgentOpen) return;
    const clean = normalizePath(path);
    const file = clean.split('/').includes('..') ? null : this.app.vault.getFileByPath(clean);
    if (!file) {
      new Notice(`Herdr: an agent asked to open "${path}", which is not in this vault.`);
      return;
    }
    const target = heading ? `${clean}#${heading}` : clean;
    await this.app.workspace.openLinkText(target, '', false, line === undefined ? undefined : { eState: { line } });
  }

  /** Writes the agent skill into the vault. Desktop only: it symlinks, and a phone's vault syncs without dotfolders. */
  public async installAgentSkill() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    await adapter.mkdir(AGENT_SKILL_DIR);
    await adapter.write(`${AGENT_SKILL_DIR}/SKILL.md`, AGENT_SKILL);
    // Loaded here, not imported: the mobile app has no fs.
    if (Platform.isDesktop) {
      const fs = (await import('fs')).promises;
      const link = `${adapter.getBasePath()}/${CLAUDE_SKILL_LINK}`;
      await fs.mkdir(link.replace(/\/[^/]+$/, ''), { recursive: true });
      await fs.rm(link, { recursive: true, force: true });
      await fs.symlink(`../../${AGENT_SKILL_DIR}`, link, 'dir');
    }
    new Notice('Herdr: agent skill installed. Agents can now open notes here.');
  }

  /** Once per vault, the terminal view asks in a tab of its own before writing into the vault. */
  public wantsSkillOffer(): boolean {
    return !this.settings.agentSkillOffered && this.settings.allowAgentOpen && !this.isRemoteBridge();
  }

  public async answerSkillOffer(install: boolean) {
    this.settings.agentSkillOffered = true;
    await this.saveSettings();
    if (install) await this.installAgentSkill();
    this.getTerminalView()?.renderTabs();
  }

  private subscribeEvents() {
    const connection = this.connection;
    this.client
      .subscribeEvents((evt) => {
        // The bridge pushes each new snapshot, wrapped in herdr's reply, or why there is none.
        if (evt.type === 'snapshot') void this.applySnapshot(evt.data.snapshot || evt.data);
        else if (evt.type === 'error') this.updateStatusBar([], false);
        else if (evt.type === 'open' && (!evt.vault || evt.vault === this.app.vault.getName())) void this.openForAgent(evt.path, evt.heading, evt.line);
        // Live vault sync: the whole vault on each (re)connect, to catch up on what the bridge pushed
        // while there was no connection, then each change it pushes. Only once the vault is loaded:
        // before, every file would look deleted on the phone.
        else if (evt.type === 'connected' && this.settings.autoSyncOnOpen) {
          this.app.workspace.onLayoutReady(() => void this.syncVault(false));
        } else if (evt.type === 'vault_changed' && evt.vault === this.app.vault.getName() && this.settings.autoSyncOnOpen) {
          this.app.workspace.onLayoutReady(() => void this.syncVault(false, evt.files));
        }
      })
      .then((unsub) => {
        if (connection !== this.connection) unsub();
        else this.unsubscribeEvents = unsub;
      })
      .catch(() => {
        // The client retries on its own; nothing to report here.
      });
  }

  /**
   * One snapshot request at a time, so a slow link can't stack them; calls made meanwhile share a
   * single follow-up, so none misses a change.
   */
  refreshState(): Promise<void> {
    if (this.refreshQueued === null) {
      this.refreshQueued = this.refreshRunning.then(() => {
        this.refreshQueued = null;
        return (this.refreshRunning = this.fetchSnapshot());
      });
    }
    return this.refreshQueued;
  }

  private async fetchSnapshot() {
    if (!this.client.isConfigured()) {
      this.updateStatusBar([], false);
      return;
    }
    let snapshot: Snapshot;
    try {
      snapshot = await this.client.snapshot();
    } catch {
      this.updateStatusBar([], false);
      return;
    }
    await this.applySnapshot(snapshot);
  }

  private async applySnapshot(snapshot: Snapshot) {
    try {
      this.singletonWorkspaceId = await this.findVaultWorkspace(snapshot);
    } catch {
      // Creating it failed: retried with the next snapshot.
    }

    const convs = this.resolver.buildConversations(snapshot, this.getVaultFolderPath());
    this.convByTab = new Map(convs.map((c) => [c.tab_id, c]));
    // Keep Next/Prev in sync when the user acts in an external Herdr TUI.
    if (snapshot.focused_tab_id && this.convByTab.has(snapshot.focused_tab_id)) {
      this.currentActiveTabId = snapshot.focused_tab_id;
    }

    // Re-rendering unchanged tabs would cost battery, and break a drag or double-click in progress.
    const key = JSON.stringify(convs);
    if (key !== this.renderedKey) {
      this.renderedKey = key;
      this.updateStatusBar(convs, true);
      this.getTerminalView()?.renderTabs();
    }
  }

  private updateStatusBar(_convs: Conversation[], _available: boolean) {}

  private pickConversation(mode: 'switch' | 'close') {
    const convs = [...this.convByTab.values()];
    const modal = new HerdrSwitcherModal(
      this.app,
      convs,
      (item: ActionItem) => {
        if (item.type === 'conversation' && item.conv) {
          void this.activateConversation(item.conv);
        } else if (item.type === 'close_conversation' && item.conv) {
          void this.closeConversationTab(item.conv);
        }
      },
      mode
    );
    modal.open();
  }

  /** Open the plugin's own page in Obsidian's settings dialog. */
  public openSettings() {
    // App.setting is undocumented but stable since v1.0; the typings omit it.
    const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  public async activateConversation(conv: Conversation) {
    this.currentActiveTabId = conv.tab_id;
    await this.activateTerminalView();
    const view = this.getTerminalView();
    if (view) {
      view.switchToTab(conv);
    }
  }

  public async renameConversationTab(conv: Conversation, newName: string) {
    try {
      await this.client.renameTab(conv.tab_id, newName);
      await this.refreshState();
    } catch (e) {
      new Notice(`Failed to rename tab: ${(e as Error).message}`);
    }
  }

  public promptRename(conv: Conversation) {
    new RenameTabModal(this.app, conv.label, (newName) => void this.renameConversationTab(conv, newName)).open();
  }

  public async closeConversationTab(conv: Conversation) {
    try {
      const snap = await this.client.snapshot();
      const wsTabs = (snap.tabs || []).filter((t) => t.workspace_id === conv.workspace_id);
      if (wsTabs.length <= 1) {
        await this.client.createTab(conv.workspace_id, 'shell', false);
      }
      await this.client.closeTab(conv.tab_id);
      void this.refreshState();
    } catch (e) {
      new Notice(`Failed to close tab: ${(e as Error).message}`);
    }
  }

  public promptNewConversation() {
    new HarnessPickerModal(this.app, (kind) => void this.startAgentConversation(kind)).open();
  }

  /** Shared: ensure vault workspace exists and create a tab of the given kind. Returns tab/pane ids. */
  private async createVaultTab(kind: string): Promise<{ tabId: string; paneId: string; workspaceId: string } | null> {
    if (!this.client.isConfigured()) {
      new Notice('Set the herdr-bridge token in the plugin settings.');
      return null;
    }
    const workspaceId = await this.findVaultWorkspace(await this.client.snapshot());
    if (!workspaceId) {
      new Notice('No herdr workspace for this vault yet: open the vault in Obsidian on the machine running herdr-bridge first.');
      return null;
    }
    this.singletonWorkspaceId = workspaceId;
    const mode = this.settings.themeMode;
    const isLight = mode === 'light'
      || (mode === 'auto' && typeof document !== 'undefined' && document.body.classList.contains('theme-light'));
    // Tell TUIs (claude, vim, ...) the terminal background synchronously via
    // COLORFGBG. OSC 11 auto-detection through the multiplexed stream is async
    // and racy (agents can render the first frames with the wrong palette),
    // while COLORFGBG is read before first render. "15;0" = light-on-dark,
    // "0;15" = dark-on-light. Set it on the tab's environment so the shell and
    // every agent it launches inherit it without typing anything into the pane.
    const tabRes = await this.client.createTab(workspaceId, kind, false, {
      COLORFGBG: isLight ? '0;15' : '15;0'
    });
    const paneId = tabRes?.root_pane?.pane_id;
    const tabId = tabRes?.tab?.tab_id;
    if (!paneId || !tabId) {
      new Notice('Could not create conversation pane.');
      return null;
    }
    this.currentActiveTabId = tabId;
    return { tabId, paneId, workspaceId };
  }

  private async revealTab(tabId: string) {
    await this.refreshState();
    await this.activateTerminalView();
    const view = this.getTerminalView();
    const conv = this.convByTab.get(tabId);
    if (view && conv) {
      view.switchToTab(conv);
    }
  }

  private async startAgentConversation(kind: string) {
    try {
      const created = await this.createVaultTab(kind);
      if (!created) return;

      const name = `${kind.replace(/[^a-z0-9_]/g, '_')}_${Date.now().toString(36)}`;
      await this.client.agentStart(name, kind, created.paneId, [], 45000);

      await this.revealTab(created.tabId);
    } catch (e) {
      new Notice(`Error starting agent: ${(e as Error).message}`);
    }
  }

  public async newShellTab() {
    try {
      const created = await this.createVaultTab('shell');
      if (!created) return;
      await this.revealTab(created.tabId);
    } catch (e) {
      new Notice(`Failed to create shell tab: ${(e as Error).message}`);
    }
  }

  /**
   * Syncs the whole vault, or with `changes` (what the bridge pushed) just those files. One sync at a
   * time, since two would race over the same files and ledger; calls made meanwhile share a single
   * follow-up, so none misses a change, and a whole-vault one covers every pushed file.
   */
  public syncVault(manual = false, changes?: RemoteChange[]): Promise<void> {
    let queued = this.syncQueued;
    if (!queued) {
      const next = { manual: false, changes: changes ? new Map<string, RemoteChange>() : null } as NonNullable<typeof this.syncQueued>;
      next.done = this.syncRunning.then(() => {
        this.syncQueued = null;
        return (this.syncRunning = this.runSync(next.manual, next.changes ? [...next.changes.values()] : undefined));
      });
      queued = this.syncQueued = next;
    }
    queued.manual ||= manual;
    if (!changes) queued.changes = null;
    else for (const c of changes) queued.changes?.set(c.path, c);
    return queued.done;
  }

  /**
   * Pushes phone edits a few seconds after the last one: Obsidian saves a note every couple of
   * seconds while typing. A whole-vault sync, so a laptop edit to the same file is still caught.
   */
  private localEdited(path: string) {
    if (!isSyncablePath(path) || !this.isRemoteBridge() || !this.settings.autoSyncOnOpen) return;
    this.localEdits.add(path);
    window.clearTimeout(this.localEditsTimer);
    this.localEditsTimer = window.setTimeout(() => {
      const ledger = this.settings.syncLedger || {};
      // A sync's own writes match its ledger: only a real edit needs a sync.
      const edited = [...this.localEdits].some((p) => {
        const file = this.app.vault.getFileByPath(p);
        return file ? file.stat.mtime !== ledger[p]?.localMtime : p in ledger;
      });
      this.localEdits.clear();
      if (edited) void this.syncVault(false);
    }, 3000);
  }

  private async runSync(manual: boolean, changes?: RemoteChange[]): Promise<void> {
    if (!this.isRemoteBridge()) return;
    if (!this.settings.bridgeToken) {
      if (manual) new Notice('Set the herdr-bridge token in the plugin settings to sync.');
      return;
    }

    if (manual) {
      new Notice('Syncing vault with laptop...');
    }

    try {
      const syncer = new VaultSync(this.app, this.bridgeHost(), this.settings.bridgeToken, HERDR_OBSIDIAN_SESSION);
      const { result, updatedLedger } = await syncer.sync(this.settings.syncLedger || {}, changes);
      this.settings.syncLedger = updatedLedger;
      await this.saveSettings();

      if (result.errors.length > 0) {
        new Notice(`Sync completed with errors: ${result.errors[0]}`);
      } else if (manual) {
        // Automatic syncs run on every edit, so they say nothing (a conflict has its own notice).
        new Notice(
          `Vault synced: ${result.pulled} pulled, ${result.pushed} pushed${
            result.conflicts ? `, ${result.conflicts} conflicts` : ''
          }`
        );
      }
    } catch (e) {
      if (manual) {
        new Notice(`Sync failed: ${(e as Error).message}`);
      }
    }
  }

  public async focusVaultWorkspace() {
    try {
      const workspaceId = this.singletonWorkspaceId || await this.findVaultWorkspace(await this.client.snapshot());
      if (!workspaceId) throw new Error('no herdr workspace for this vault yet');
      await this.client.focusWorkspace(workspaceId);
    } catch (e) {
      new Notice(`Failed to focus workspace: ${(e as Error).message}`);
    }
  }

  public async diagnoseConnection() {
    const where = this.isRemoteBridge() ? 'another machine' : 'this machine';
    const folder = this.getVaultFolderPath();
    let detail = `herdr-bridge: ${this.client.getHost()} (${where})\nToken set: ${this.client.isConfigured() ? 'yes' : 'no'}\nVault folder: ${folder}`;
    try {
      const snapshot = await this.client.snapshot();
      const ws = this.resolver.findWorkspaceForFolder(snapshot, folder);
      const convs = this.resolver.buildConversations(snapshot, folder);
      detail += `\nWorkspaces: ${(snapshot.workspaces || []).length}`;
      detail += `\nMatched workspace: ${ws ? `${ws.label} (${ws.workspace_id})` : '(none)'}`;
      detail += `\nTabs in vault: ${convs.length}`;
      for (const c of convs.slice(0, 10)) {
        detail += `\n- ${c.label}: ${c.status}`;
      }
      if (convs.length > 10) detail += `\n... and ${convs.length - 10} more`;
    } catch (e) {
      detail += `\nSnapshot failed: ${(e as Error).message}`;
    }
    new Notice(detail, 12000);
  }

  public focusHerdrTab(tabId: string) {
    this.client.focusTab(tabId).catch(() => {
      // Best effort: herdr's own focus only follows along.
    });
  }

  private switchNext() {
    const convs = this.getConversations();
    if (convs.length === 0) return;
    const currIdx = convs.findIndex((c) => c.tab_id === this.currentActiveTabId);
    const nextIdx = currIdx === -1 ? 0 : (currIdx + 1) % convs.length;
    void this.activateConversation(convs[nextIdx]);
  }

  private switchPrev() {
    const convs = this.getConversations();
    if (convs.length === 0) return;
    const currIdx = convs.findIndex((c) => c.tab_id === this.currentActiveTabId);
    const prevIdx = currIdx === -1 ? 0 : (currIdx - 1 + convs.length) % convs.length;
    void this.activateConversation(convs[prevIdx]);
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<HerdrSettings> | null) };
    // The old secret control saved a SecretStorage ID where the bridge expects the token itself.
    const secret = this.settings.bridgeToken && this.app.secretStorage?.getSecret(this.settings.bridgeToken);
    if (secret) {
      this.settings.bridgeToken = secret;
      await this.saveSettings();
    }
  }

  /** Only persists: the settings tab reconnects once, when it closes, instead of on every keystroke. */
  async saveSettings() {
    await this.saveData(this.settings);
  }
}

export class HerdrSettingTab extends PluginSettingTab {
  plugin: HerdrPlugin;

  constructor(app: App, plugin: HerdrPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** The bridge host and token when the tab opened, to tell whether closing it must move the terminal. */
  private shownBridge: string | null = null;

  override getControlValue(key: string): unknown {
    if (this.shownBridge === null) {
      const { bridgeHost, bridgeToken } = this.plugin.settings;
      this.shownBridge = `${bridgeHost}\n${bridgeToken}`;
    }
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const val = typeof value === 'string' ? value.trim() : value;
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = val;
    await this.plugin.saveSettings();
    if (key === 'themeMode' || key === 'fontSize') {
      this.plugin.getTerminalView()?.updateSettings();
    }
    if (key === 'themeMode') {
      void this.plugin.sendAppearance();
    }
  }

  hide(): void {
    this.plugin.connect();
    const { bridgeHost, bridgeToken } = this.plugin.settings;
    if (this.shownBridge !== null && `${bridgeHost}\n${bridgeToken}` !== this.shownBridge) {
      this.plugin.getTerminalView()?.resume();
    }
    this.shownBridge = null;
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: 'Theme mode',
        desc: "Follow Obsidian's theme, or force dark or light terminal colors.",
        control: {
          key: 'themeMode',
          type: 'dropdown',
          options: {
            auto: 'Follow Obsidian',
            dark: 'Dark',
            light: 'Light',
          },
        },
      },
      {
        name: 'Font size',
        desc: 'Terminal font size in pixels.',
        control: {
          key: 'fontSize',
          type: 'slider',
          min: 8,
          max: 32,
          step: 1,
        },
      },
      {
        name: "'Send to agent' menu option",
        desc: "Add 'Send to agent' to editor and file context menus to insert references into the terminal.",
        control: {
          key: 'sendToAgentMenu',
          type: 'toggle',
        },
      },
      {
        name: 'Let agents open notes',
        desc: 'Agents can ask Obsidian to show a note, heading or line from this vault with herdr-bridge open.',
        control: {
          key: 'allowAgentOpen',
          type: 'toggle',
        },
      },
      {
        type: 'group',
        heading: 'Connection',
        items: [
          {
            name: 'Bridge host',
            desc: `host:port of herdr-bridge. Empty: this machine (${LOCAL_BRIDGE}). From a phone: the laptop's address, e.g. its Tailscale IP 100.85.12.34:7788.`,
            control: {
              key: 'bridgeHost',
              type: 'text',
              placeholder: LOCAL_BRIDGE,
            },
          },
          {
            name: 'Bridge token',
            desc: 'Run herdr-bridge --print-token on the machine running herdr-bridge. Enter that token here.',
            render: (setting) => {
              const value = this.getControlValue('bridgeToken') as string;
              let hidden = !!value;
              let previous = value.replace(/[\s-]/g, '').toUpperCase().match(/.{1,4}/g)?.join('-') ?? '';
              let input: HTMLInputElement;
              setting.addText((text) => {
                input = text.inputEl;
                input.type = hidden ? 'password' : 'text';
                input.autocomplete = 'off';
                input.spellcheck = false;
                input.setAttribute('autocapitalize', 'characters');
                input.setAttribute('autocorrect', 'off');
                input.setAttribute('aria-label', 'Bridge token');
                text.setPlaceholder('Token').setValue(previous).onChange((value) => {
                  let raw = value.replace(/[\s-]/g, '').toUpperCase();
                  let at = value.slice(0, input.selectionStart ?? value.length).replace(/[\s-]/g, '').length;
                  // Backspace over a separator deletes the preceding character, as in herdr-mobile.
                  if (value.length < previous.length && raw === previous.replace(/-/g, '') && at > 0) {
                    raw = raw.slice(0, at - 1) + raw.slice(at);
                    at--;
                  }
                  input.value = previous = raw.match(/.{1,4}/g)?.join('-') ?? '';
                  const cursor = at + (at > 0 ? Math.floor((at - 1) / 4) : 0);
                  input.setSelectionRange(cursor, cursor);
                  void this.setControlValue('bridgeToken', raw);
                });
              });
              setting.addExtraButton((button) => {
                button.setIcon(hidden ? 'eye' : 'eye-off').setTooltip(hidden ? 'Show token' : 'Hide token').onClick(() => {
                  hidden = !hidden;
                  input.type = hidden ? 'password' : 'text';
                  button.setIcon(hidden ? 'eye' : 'eye-off').setTooltip(hidden ? 'Show token' : 'Hide token');
                });
              });
            },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Vault sync',
        visible: () => this.plugin.isRemoteBridge(),
        items: [
          {
            name: 'Sync automatically',
            desc: "Sync with the laptop's vault of the same name when Obsidian opens or comes back to the foreground.",
            control: {
              key: 'autoSyncOnOpen',
              type: 'toggle',
            },
          },
          {
            name: 'Sync now',
            desc: "Pull the laptop's changes to this vault and push this vault's changes to the laptop.",
            render: (setting) => {
              setting.addButton((btn) =>
                btn
                  .setButtonText('Sync')
                  .setCta()
                  .onClick(() => void this.plugin.syncVault(true))
              );
            },
          },
        ],
      },
    ];
  }
}

interface LineRef {
  path: string;
  start?: number;
  end?: number;
}

/** The lines an editor selection covers; a selection ending at a line's start doesn't take that line. */
function editorRef(editor: Editor, file: TFile): LineRef | null {
  if (!editor.somethingSelected()) return null;
  const from = editor.getCursor('from');
  const to = editor.getCursor('to');
  const end = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
  return { path: file.path, start: from.line + 1, end: end + 1 };
}

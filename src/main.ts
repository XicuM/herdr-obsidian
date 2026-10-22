import { App, Editor, MarkdownPreviewView, MarkdownView, Menu, TFile, Plugin, normalizePath, PluginSettingTab, Setting, Notice, FileSystemAdapter, WorkspaceLeaf, Platform } from 'obsidian';
import { HerdrClient, Snapshot } from './herdrClient';
import { TerminalStream, TerminalStreamCallbacks } from './terminalStream';
import { VaultSync, SyncLedger, RemoteChange, isSyncablePath } from './vaultSync';
import { AgentResolver, Conversation } from './resolver';
import { HerdrSwitcherModal, HarnessPickerModal, ActionItem } from './switcherModal';
import { HerdrTerminalView, HERDR_VIEW_TYPE } from './terminalView';
import { RenameTabModal } from './renameModal';
import { criticMarkupEditor, renderCriticMarkup, resolveAll, changeAt } from './criticMarkup';

export const HERDR_OBSIDIAN_SESSION = 'herdr-obsidian';
/** herdr-bridge on this machine, where the desktop app finds it unless told otherwise. */
const LOCAL_BRIDGE = '127.0.0.1:7788';

export interface HerdrSettings {
  themeMode: 'auto' | 'dark' | 'light';
  fontSize: number;
  addAtPrefixOnDrop: boolean;
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
  fontSize: 14,
  addAtPrefixOnDrop: true,
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
  private statusBarEl!: HTMLElement;
  private unsubscribeEvents: (() => void) | null = null;
  /** Bumped on each disconnect, so a subscription that resolves afterwards knows it is stale. */
  private connection = 0;
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

    // Register Terminal View in Obsidian UI
    this.registerView(
      HERDR_VIEW_TYPE,
      (leaf) => new HerdrTerminalView(leaf, this)
    );

    // Create Status Bar Item
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('herdr-status-bar');
    this.statusBarEl.addEventListener('click', () => {
      if (!this.client.isConfigured()) {
        this.openSettings();
        return;
      }
      const blocked = this.getConversations().find((c) => c.status === 'blocked');
      if (blocked) {
        void this.activateConversation(blocked);
        return;
      }
      this.pickConversation('switch');
    });

    this.addRibbonIcon('bot', 'Open agent terminal', () => void this.activateTerminalView());

    // Commands
    this.addCommand({
      id: 'open-view',
      name: 'Open terminal view',
      callback: () => void this.activateTerminalView()
    });

    this.addCommand({
      id: 'switch-conversation',
      name: 'Switch agent conversation',
      callback: () => this.pickConversation('switch')
    });

    this.addCommand({
      id: 'switch-next',
      name: 'Next agent conversation',
      callback: () => this.switchNext()
    });

    this.addCommand({
      id: 'switch-prev',
      name: 'Previous agent conversation',
      callback: () => this.switchPrev()
    });

    this.addCommand({
      id: 'new-conversation',
      name: 'New agent conversation',
      callback: () => this.promptNewConversation()
    });

    this.addCommand({
      id: 'new-shell-tab',
      name: 'New shell tab',
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
    // Reading view leaves selections to Electron's native Copy menu; replace it with ours.
    this.registerDomEvent(document, 'contextmenu', (e) => {
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

  private updateStatusBar(convs: Conversation[], available: boolean) {
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    this.statusBarEl.removeClass('is-blocked', 'is-working', 'is-offline');

    if (!available) {
      this.renderedKey = '';
      this.statusBarEl.addClass('is-offline');
      this.statusBarEl.createSpan({ text: 'Herdr (offline)' });
      this.statusBarEl.setAttribute('aria-label', `herdr-bridge at ${this.bridgeHost()} is unreachable, or its token is missing.`);
      return;
    }

    if (convs.length === 0) {
      this.statusBarEl.createSpan({ text: 'Herdr' });
      this.statusBarEl.setAttribute('aria-label', 'No active conversations in this vault. Click to open or create one.');
      return;
    }

    const blocked = convs.filter((c) => c.status === 'blocked');
    const working = convs.filter((c) => c.status === 'working');

    const topStatus = blocked.length > 0 ? 'blocked' : working.length > 0 ? 'working' : 'done';
    this.statusBarEl.createSpan({ cls: `herdr-status-dot status-${topStatus}` });

    if (blocked.length > 0) {
      this.statusBarEl.addClass('is-blocked');
      const label = blocked.length === 1
        ? `${blocked[0].label} blocked`
        : `${blocked.length} blocked`;
      this.statusBarEl.createSpan({ text: `Herdr: ${label}` });
      this.statusBarEl.setAttribute('aria-label', `${blocked.length} agent(s) waiting for input: ${blocked.map((b) => b.label).join(', ')}. Click to attend.`);
    } else if (working.length > 0) {
      this.statusBarEl.addClass('is-working');
      this.statusBarEl.createSpan({ text: `Herdr (${working.length} working)` });
      this.statusBarEl.setAttribute('aria-label', `${working.length} agent(s) working. Click to open.`);
    } else {
      this.statusBarEl.createSpan({ text: `Herdr (${convs.length})` });
      this.statusBarEl.setAttribute('aria-label', `${convs.length} agent(s) active. Click to open.`);
    }
  }

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
        } else if (item.type === 'new_shell') {
          void this.newShellTab();
        } else if (item.type === 'open_settings') {
          this.openSettings();
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
  }

  /** Only persists: the settings tab reconnects once, when it closes, instead of on every keystroke. */
  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class HerdrSettingTab extends PluginSettingTab {
  plugin: HerdrPlugin;

  constructor(app: App, plugin: HerdrPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** The bridge host and token when the tab opened, to tell whether closing it must move the terminal. */
  private shownBridge = '';

  hide(): void {
    this.plugin.connect();
    const { bridgeHost, bridgeToken } = this.plugin.settings;
    if (`${bridgeHost}\n${bridgeToken}` !== this.shownBridge) {
      this.plugin.getTerminalView()?.resume();
    }
  }

  display(): void {
    const { containerEl } = this;
    const { settings } = this.plugin;
    this.shownBridge = `${settings.bridgeHost}\n${settings.bridgeToken}`;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Theme mode')
      .setDesc("Follow Obsidian's theme, or force dark or light terminal colors.")
      .addDropdown((drop) =>
        drop
          .addOption('auto', 'Follow Obsidian')
          .addOption('dark', 'Dark')
          .addOption('light', 'Light')
          .setValue(settings.themeMode)
          .onChange(async (val) => {
            settings.themeMode = val as HerdrSettings['themeMode'];
            await this.plugin.saveSettings();
            this.plugin.getTerminalView()?.updateSettings();
          })
      );

    new Setting(containerEl)
      .setName('Font size')
      .setDesc('Terminal font size in pixels.')
      .addSlider((slider) =>
        slider
          .setLimits(8, 32, 1)
          .setValue(settings.fontSize)
          .onChange(async (val) => {
            settings.fontSize = val;
            await this.plugin.saveSettings();
            this.plugin.getTerminalView()?.updateSettings();
          })
      );

    new Setting(containerEl)
      .setName('Prefix dropped files with @')
      .setDesc("Insert paths in each agent's own mention syntax (@notes/spec.md for Claude, notes/spec.md for Codex). Shell tabs get a plain path.")
      .addToggle((toggle) =>
        toggle.setValue(settings.addAtPrefixOnDrop).onChange(async (val) => {
          settings.addAtPrefixOnDrop = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Let agents open notes')
      .setDesc('Agents can ask Obsidian to show a note, heading or line from this vault with herdr-bridge open.')
      .addToggle((toggle) =>
        toggle.setValue(settings.allowAgentOpen).onChange(async (val) => {
          settings.allowAgentOpen = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName('Connection').setHeading();

    new Setting(containerEl)
      .setName('Bridge host')
      .setDesc(`host:port of herdr-bridge. Empty: this machine (${LOCAL_BRIDGE}). From a phone: the laptop's address, e.g. its Tailscale IP 100.85.12.34:7788.`)
      .addText((text) =>
        text
          .setPlaceholder(LOCAL_BRIDGE)
          .setValue(settings.bridgeHost)
          .onChange(async (val) => {
            settings.bridgeHost = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Bridge token')
      .setDesc('Shown by running herdr-bridge --print-token on the machine running herdr-bridge.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('Token')
          .setValue(settings.bridgeToken)
          .onChange(async (val) => {
            settings.bridgeToken = val.trim();
            await this.plugin.saveSettings();
          });
      });

    if (!this.plugin.isRemoteBridge()) return;

    new Setting(containerEl).setName('Vault sync').setHeading();

    new Setting(containerEl)
      .setName('Sync automatically')
      .setDesc("Sync with the laptop's vault of the same name when Obsidian opens or comes back to the foreground.")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSyncOnOpen).onChange(async (val) => {
          settings.autoSyncOnOpen = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc("Pull the laptop's changes to this vault and push this vault's changes to the laptop.")
      .addButton((btn) =>
        btn
          .setButtonText('Sync')
          .setCta()
          .onClick(() => void this.plugin.syncVault(true))
      );
  }
}

interface LineRef {
  path: string;
  start: number;
  end: number;
}

/** The lines an editor selection covers; a selection ending at a line's start doesn't take that line. */
function editorRef(editor: Editor, file: TFile): LineRef | null {
  if (!editor.somethingSelected()) return null;
  const from = editor.getCursor('from');
  const to = editor.getCursor('to');
  const end = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
  return { path: file.path, start: from.line + 1, end: end + 1 };
}

import { App, Plugin, PluginSettingTab, Setting, Notice, FileSystemAdapter, WorkspaceLeaf } from 'obsidian';
import * as os from 'os';
import * as path from 'path';
import { HerdrClient, Snapshot } from './herdrClient';
import { AgentResolver, Conversation } from './resolver';
import { AgentAttender } from './notifier';
import { HerdrSwitcherModal, HarnessPickerModal, ActionItem } from './switcherModal';
import { HerdrTerminalView, HERDR_VIEW_TYPE } from './terminalView';
import { RenameTabModal } from './renameModal';

export const HERDR_OBSIDIAN_SESSION = 'herdr-obsidian';

interface HerdrSettings {
  focusOnBlocked: boolean;
  themeMode: 'auto' | 'dark' | 'light';
  fontSize: number;
  refreshIntervalSeconds: number;
  addAtPrefixOnDrop: boolean;
  tabOrder?: string[];
}

const DEFAULT_SETTINGS: HerdrSettings = {
  focusOnBlocked: true,
  themeMode: 'auto', // Follow Obsidian theme
  fontSize: 14,
  refreshIntervalSeconds: 2,
  addAtPrefixOnDrop: true,
  tabOrder: []
};

export default class HerdrPlugin extends Plugin {
  settings: HerdrSettings = DEFAULT_SETTINGS;
  private client!: HerdrClient;
  private resolver!: AgentResolver;
  private attender!: AgentAttender;
  private statusBarEl!: HTMLElement;
  private refreshTimer: any;
  private unsubscribeEvents: (() => void) | null = null;
  private convByTab = new Map<string, Conversation>();
  private currentActiveTabId?: string;
  private singletonWorkspaceId?: string;

  async onload() {
    await this.loadSettings();
    this.initClient();

    // Register Terminal View in Obsidian UI
    this.registerView(
      HERDR_VIEW_TYPE,
      (leaf) => new HerdrTerminalView(leaf, this)
    );

    // Create Status Bar Item
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('herdr-status-bar');
    this.statusBarEl.addEventListener('click', () => {
      if (!this.client.isAvailable()) {
        new Notice('Checking Herdr daemon...');
        this.refreshState();
        return;
      }
      const blocked = this.getConversations().find((c) => c.status === 'blocked');
      if (blocked) {
        this.activateConversation(blocked);
        return;
      }
      this.pickConversation('switch');
    });

    // Add Ribbon Icon to toggle the Herdr Agent Terminal UI
    this.addRibbonIcon('terminal', 'Open Herdr Terminal', () => {
      this.activateTerminalView();
    });

    // Commands
    this.addCommand({
      id: 'open-herdr-view',
      name: 'Open Herdr Terminal View',
      callback: () => this.activateTerminalView()
    });

    this.addCommand({
      id: 'switch-conversation',
      name: 'Switch Agent Conversation',
      callback: () => this.pickConversation('switch')
    });

    this.addCommand({
      id: 'switch-next',
      name: 'Next Agent Conversation',
      callback: () => this.switchNext()
    });

    this.addCommand({
      id: 'switch-prev',
      name: 'Previous Agent Conversation',
      callback: () => this.switchPrev()
    });

    this.addCommand({
      id: 'new-conversation',
      name: 'New Agent Conversation',
      callback: () => this.promptNewConversation()
    });

    this.addCommand({
      id: 'new-shell-tab',
      name: 'New Shell Tab',
      callback: () => this.newShellTab()
    });

    this.addCommand({
      id: 'rename-current-tab',
      name: 'Rename Active Tab',
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
      name: 'Close Conversation',
      callback: () => this.pickConversation('close')
    });

    this.addCommand({
      id: 'focus-workspace',
      name: 'Focus Vault Workspace',
      callback: () => this.focusVaultWorkspace()
    });

    this.addCommand({
      id: 'diagnose-connection',
      name: 'Diagnose Herdr Connection',
      callback: () => this.diagnoseConnection()
    });

    this.addCommand({
      id: 'refresh-status',
      name: 'Refresh Herdr Status',
      callback: () => this.refreshState()
    });

    this.addSettingTab(new HerdrSettingTab(this.app, this));

    this.setupRefresh();
    this.refreshState();

    this.subscribeEvents();
  }

  onunload() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    if (this.unsubscribeEvents) {
      try {
        this.unsubscribeEvents();
      } catch {}
      this.unsubscribeEvents = null;
    }
  }

  private initClient() {
    // Close the previous event subscription before replacing the client (prevents socket leaks on settings change).
    if (this.unsubscribeEvents) {
      try {
        this.unsubscribeEvents();
      } catch {}
      this.unsubscribeEvents = null;
    }
    this.client = new HerdrClient(HERDR_OBSIDIAN_SESSION);
    this.resolver = new AgentResolver(this.client);
    if (this.attender) {
      this.attender.updateConfig(this.settings);
    } else {
      this.attender = new AgentAttender(this.settings);
    }
    this.attender.setOnFocus((conv) => {
      this.activateTerminalView().then(() => {
        const view = this.getTerminalView();
        view?.switchToTab(conv);
      });
    });
  }

  public getVaultFolderPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return os.homedir();
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
        const orderA = orderMap.has(a.tab_id) ? orderMap.get(a.tab_id)! : 9999;
        const orderB = orderMap.has(b.tab_id) ? orderMap.get(b.tab_id)! : 9999;
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
      workspace.revealLeaf(leaf);
    }
  }

  public getTerminalView(): HerdrTerminalView | null {
    const leaves = this.app.workspace.getLeavesOfType(HERDR_VIEW_TYPE);
    if (leaves.length > 0 && leaves[0].view instanceof HerdrTerminalView) {
      return leaves[0].view as HerdrTerminalView;
    }
    return null;
  }

  private setupRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    const ms = Math.max(1, this.settings.refreshIntervalSeconds) * 1000;
    this.refreshTimer = setInterval(() => {
      this.refreshState();
    }, ms);
  }

  private subscribeEvents() {
    this.client
      .subscribeEvents((evt) => {
        const type = evt.type || evt.event;
        if (
          type === 'pane.agent_status_changed' ||
          type === 'pane.agent_detected' ||
          type === 'tab.created' ||
          type === 'tab.closed' ||
          type === 'tab.renamed' ||
          type === 'workspace.created' ||
          type === 'workspace.closed'
        ) {
          this.refreshState();
        }
      })
      .then((unsub) => {
        this.unsubscribeEvents = unsub;
      })
      .catch(() => {});
  }

  async refreshState() {
    if (!this.client.isAvailable()) {
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

    const folder = this.getVaultFolderPath();
    try {
      this.singletonWorkspaceId = await this.resolver.ensureWorkspace(folder, snapshot);
    } catch {}

    const convs = this.resolver.buildConversations(snapshot, folder);
    this.convByTab = new Map(convs.map((c) => [c.tab_id, c]));
    // Keep Next/Prev in sync when the user acts in an external Herdr TUI.
    if (snapshot.focused_tab_id && this.convByTab.has(snapshot.focused_tab_id)) {
      this.currentActiveTabId = snapshot.focused_tab_id;
    }
    this.attender.setConversations(convs);
    this.updateStatusBar(convs, true);

    const view = this.getTerminalView();
    if (view) {
      view.renderTabs();
    }

    for (const c of convs) {
      this.attender.handleStatusChange(c.pane_id, c.status);
    }
  }

  private updateStatusBar(convs: Conversation[], available: boolean) {
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    this.statusBarEl.removeClass('is-blocked', 'is-working', 'is-offline');

    if (!available) {
      this.statusBarEl.addClass('is-offline');
      this.statusBarEl.createSpan({ text: 'Herdr (offline)' });
      this.statusBarEl.setAttribute('aria-label', 'Herdr daemon is not running. Click to check connection.');
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
          this.activateConversation(item.conv);
        } else if (item.type === 'close_conversation' && item.conv) {
          this.closeConversationTab(item.conv);
        } else if (item.type === 'new_shell') {
          this.newShellTab();
        } else if (item.type === 'refresh') {
          this.refreshState();
        }
      },
      mode
    );
    modal.open();
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
    } catch (e: any) {
      new Notice(`Failed to rename tab: ${e.message}`);
    }
  }

  public promptRename(conv: Conversation) {
    new RenameTabModal(this.app, conv.label, (newName) => {
      this.renameConversationTab(conv, newName);
    }).open();
  }

  public async closeConversationTab(conv: Conversation) {
    try {
      const snap = await this.client.snapshot();
      const wsTabs = (snap.tabs || []).filter((t) => t.workspace_id === conv.workspace_id);
      if (wsTabs.length <= 1) {
        await this.client.createTab(conv.workspace_id, 'shell', false);
      }
      await this.client.closeTab(conv.tab_id);
      this.refreshState();
    } catch (e: any) {
      new Notice(`Failed to close tab: ${e.message}`);
    }
  }

  public promptNewConversation() {
    new HarnessPickerModal(this.app, (kind) => {
      this.startAgentConversation(kind);
    }).open();
  }

  /** Shared: ensure vault workspace exists and create a tab of the given kind. Returns tab/pane ids. */
  private async createVaultTab(kind: string): Promise<{ tabId: string; paneId: string; workspaceId: string } | null> {
    if (!this.client.isAvailable()) {
      new Notice('Herdr is not running. Please start Herdr daemon first.');
      return null;
    }
    const folder = this.getVaultFolderPath();
    const snapshot = await this.client.snapshot();
    const workspaceId = await this.resolver.ensureWorkspace(folder, snapshot);
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
    } catch (e: any) {
      new Notice(`Error starting agent: ${e.message}`);
    }
  }

  public async newShellTab() {
    try {
      const created = await this.createVaultTab('shell');
      if (!created) return;
      await this.revealTab(created.tabId);
    } catch (e: any) {
      new Notice(`Failed to create shell tab: ${e.message}`);
    }
  }

  public async focusVaultWorkspace() {
    try {
      const folder = this.getVaultFolderPath();
      const snapshot = await this.client.snapshot();
      const workspaceId = this.singletonWorkspaceId || await this.resolver.ensureWorkspace(folder, snapshot);
      await this.client.focusWorkspace(workspaceId);
    } catch (e: any) {
      new Notice(`Failed to focus workspace: ${e.message}`);
    }
  }

  public async diagnoseConnection() {
    const socketPath = this.client.getSocketPath();
    const available = this.client.isAvailable();
    const folder = this.getVaultFolderPath();
    let detail = `Socket: ${socketPath}\nAvailable: ${available ? 'yes' : 'no'}\nVault folder: ${folder}`;
    try {
      const snapshot = await this.client.snapshot();
      const ws = this.resolver.findWorkspaceForFolder(snapshot, folder);
      const convs = this.resolver.buildConversations(snapshot, folder);
      detail += `\nWorkspaces: ${(snapshot.workspaces || []).length}`;
      detail += `\nMatched workspace: ${ws ? `${ws.label} (${ws.workspace_id})` : '(none — will be created on refresh)'}`;
      detail += `\nTabs in vault: ${convs.length}`;
      for (const c of convs.slice(0, 10)) {
        detail += `\n- ${c.label}: ${c.status}`;
      }
      if (convs.length > 10) detail += `\n... and ${convs.length - 10} more`;
    } catch (e: any) {
      detail += `\nSnapshot failed: ${e.message}`;
    }
    new Notice(detail, 12000);
  }

  public focusHerdrTab(tabId: string) {
    this.client.focusTab(tabId).catch(() => {});
  }

  private switchNext() {
    const convs = [...this.convByTab.values()];
    if (convs.length === 0) return;
    const currIdx = convs.findIndex((c) => c.tab_id === this.currentActiveTabId);
    const nextIdx = currIdx === -1 ? 0 : (currIdx + 1) % convs.length;
    this.activateConversation(convs[nextIdx]);
  }

  private switchPrev() {
    const convs = [...this.convByTab.values()];
    if (convs.length === 0) return;
    const currIdx = convs.findIndex((c) => c.tab_id === this.currentActiveTabId);
    const prevIdx = currIdx === -1 ? 0 : (currIdx - 1 + convs.length) % convs.length;
    this.activateConversation(convs[prevIdx]);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.initClient();
    this.setupRefresh();
    this.subscribeEvents();
    this.refreshState();
    const view = this.getTerminalView();
    if (view) {
      view.updateSettings();
    }
  }
}

class HerdrSettingTab extends PluginSettingTab {
  plugin: HerdrPlugin;

  constructor(app: App, plugin: HerdrPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Herdr Obsidian Settings' });

    new Setting(containerEl)
      .setName('Focus on blocked')
      .setDesc('When an agent transitions to blocked (waiting for input), open the terminal view and show a notice. Off = silent, no focus steal.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.focusOnBlocked).onChange(async (val) => {
          this.plugin.settings.focusOnBlocked = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Theme mode')
      .setDesc('Match Obsidian theme automatically or enforce dark/light colors for the terminal.')
      .addDropdown((drop) =>
        drop
          .addOption('auto', 'Auto (Follow Obsidian)')
          .addOption('dark', 'Dark')
          .addOption('light', 'Light')
          .setValue(this.plugin.settings.themeMode)
          .onChange(async (val: 'auto' | 'dark' | 'light') => {
            this.plugin.settings.themeMode = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Refresh interval')
      .setDesc('How often to query the Herdr daemon for agent state (seconds). Live socket events also trigger refreshes.')
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.refreshIntervalSeconds)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.refreshIntervalSeconds = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Font size')
      .setDesc('Terminal font size in pixels (default 14).')
      .addSlider((slider) =>
        slider
          .setLimits(8, 32, 1)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.fontSize = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Prefix dropped files with @')
      .setDesc('Insert paths in each agent\'s own mention syntax (@notes/spec.md for Claude, notes/spec.md for Codex). Shell tabs get a plain path.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.addAtPrefixOnDrop).onChange(async (val) => {
          this.plugin.settings.addAtPrefixOnDrop = val;
          await this.plugin.saveSettings();
        })
      );
  }
}

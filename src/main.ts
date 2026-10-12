import { App, Plugin, PluginSettingTab, Setting, Notice, FileSystemAdapter, WorkspaceLeaf } from 'obsidian';
import * as os from 'os';
import * as path from 'path';
import { HerdrClient, Snapshot } from './herdrClient';
import { AgentResolver, Conversation } from './resolver';
import { AgentAttender, statusEmoji } from './notifier';
import { HerdrSwitcherModal, HarnessPickerModal, ActionItem } from './switcherModal';
import { HerdrTerminalView, HERDR_VIEW_TYPE } from './terminalView';

interface HerdrSettings {
  focusOnBlocked: boolean;
  session: string;
  refreshIntervalSeconds: number;
}

const DEFAULT_SETTINGS: HerdrSettings = {
  focusOnBlocked: true,
  session: '', // Default desktop session
  refreshIntervalSeconds: 2
};

export default class HerdrCompanionPlugin extends Plugin {
  settings: HerdrSettings = DEFAULT_SETTINGS;
  private client!: HerdrClient;
  private resolver!: AgentResolver;
  private attender!: AgentAttender;
  private statusBarEl!: HTMLElement;
  private refreshTimer: any;
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
      this.pickConversation('switch');
    });

    // Add Ribbon Icon to toggle the Herdr Agent Terminal UI
    this.addRibbonIcon('terminal', 'Open Herdr Agents Terminal', () => {
      this.activateTerminalView();
    });

    // Add Commands
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
      id: 'close-conversation',
      name: 'Close Conversation',
      callback: () => this.pickConversation('close')
    });

    this.addCommand({
      id: 'refresh-status',
      name: 'Refresh Herdr Status',
      callback: () => this.refreshState()
    });

    this.addCommand({
      id: 'diagnose',
      name: 'Diagnose Herdr Connection',
      callback: () => this.diagnose()
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
  }

  private initClient() {
    this.client = new HerdrClient(this.settings.session);
    this.resolver = new AgentResolver(this.client);
    this.attender = new AgentAttender(this.settings);
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

  public getConversations(): Conversation[] {
    return [...this.convByTab.values()];
  }

  public async activateTerminalView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(HERDR_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      // Open in the right dock / sidebar, or main leaf if preferred
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
    // Ensure singleton workspace for this vault
    try {
      this.singletonWorkspaceId = await this.resolver.ensureWorkspace(folder, snapshot);
    } catch {}

    const convs = this.resolver.buildConversations(snapshot, folder);
    this.convByTab = new Map(convs.map((c) => [c.tab_id, c]));
    this.attender.setConversations(convs);
    this.updateStatusBar(convs, true);

    // Update active in-app terminal tabs if open
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
      this.statusBarEl.createSpan({ text: '🚫 Herdr (offline)' });
      this.statusBarEl.setAttribute('aria-label', 'Herdr daemon is not running');
      return;
    }

    if (convs.length === 0) {
      this.statusBarEl.createSpan({ text: '⚡ Herdr (+)' });
      this.statusBarEl.setAttribute('aria-label', 'No active conversations in this vault. Click to open or create one.');
      return;
    }

    const blocked = convs.filter((c) => c.status === 'blocked');
    const working = convs.filter((c) => c.status === 'working');

    if (blocked.length > 0) {
      this.statusBarEl.addClass('is-blocked');
      this.statusBarEl.createSpan({ text: `🔔 Herdr: ${blocked.map((b) => b.label).join(', ')} blocked` });
      this.statusBarEl.setAttribute('aria-label', `${blocked.length} agent(s) waiting for input. Click to open.`);
    } else if (working.length > 0) {
      this.statusBarEl.addClass('is-working');
      const labels = convs
        .map((c) => {
          const emoji = statusEmoji(c.status);
          return emoji ? `${emoji} ${c.label}` : c.label;
        })
        .join(' ');
      this.statusBarEl.createSpan({ text: `🔄 Herdr: ${labels}` });
      this.statusBarEl.setAttribute('aria-label', `${working.length} agent(s) working. Click to open.`);
    } else {
      const labels = convs
        .map((c) => {
          const emoji = statusEmoji(c.status);
          return emoji ? `${emoji} ${c.label}` : c.label;
        })
        .join(' ');
      this.statusBarEl.createSpan({ text: `💻 Herdr: ${labels}` });
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
        } else if (item.type === 'new_conversation') {
          this.promptNewConversation();
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

  public async closeConversationTab(conv: Conversation) {
    try {
      const snap = await this.client.snapshot();
      const wsTabs = (snap.tabs || []).filter((t) => t.workspace_id === conv.workspace_id);
      if (wsTabs.length <= 1) {
        // If it's the last tab in the vault's singleton workspace, spawn a fresh shell tab first
        await this.client.createTab(conv.workspace_id, 'shell', false);
      }
      await this.client.closeTab(conv.tab_id);
      new Notice(`Closed tab: ${conv.label}`);
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

  private async startAgentConversation(kind: string) {
    if (!this.client.isAvailable()) {
      new Notice('Herdr is not running. Please start Herdr daemon first.');
      return;
    }
    const folder = this.getVaultFolderPath();
    try {
      const snapshot = await this.client.snapshot();
      const workspaceId = await this.resolver.ensureWorkspace(folder, snapshot);
      this.singletonWorkspaceId = workspaceId;

      const tabRes = await this.client.createTab(workspaceId, null, false);
      const paneId = tabRes?.root_pane?.pane_id;
      const tabId = tabRes?.tab?.tab_id;
      if (!paneId || !tabId) {
        new Notice('Could not create conversation pane.');
        return;
      }

      this.currentActiveTabId = tabId;

      const name = `${kind.replace(/[^a-z0-9_]/g, '_')}_${Date.now().toString(36)}`;
      new Notice(`Starting ${kind} agent...`);
      await this.client.agentStart(name, kind, paneId, [], 45000);
      new Notice(`Agent ${kind} started!`);

      await this.refreshState();
      await this.activateTerminalView();
      const view = this.getTerminalView();
      const conv = this.convByTab.get(tabId);
      if (view && conv) {
        view.switchToTab(conv);
      }
    } catch (e: any) {
      new Notice(`Error starting agent: ${e.message}`);
    }
  }

  public async newShellTab() {
    if (!this.client.isAvailable()) {
      new Notice('Herdr is not running.');
      return;
    }
    const folder = this.getVaultFolderPath();
    try {
      const snap = await this.client.snapshot();
      const workspaceId = await this.resolver.ensureWorkspace(folder, snap);
      this.singletonWorkspaceId = workspaceId;
      const tabRes = await this.client.createTab(workspaceId, 'shell', false);
      if (tabRes?.tab?.tab_id) {
        this.currentActiveTabId = tabRes.tab.tab_id;
        new Notice('Created new shell tab.');
      }
      await this.refreshState();
      await this.activateTerminalView();
      const view = this.getTerminalView();
      if (view && tabRes?.tab?.tab_id) {
        const conv = this.convByTab.get(tabRes.tab.tab_id);
        if (conv) view.switchToTab(conv);
      }
    } catch (e: any) {
      new Notice(`Failed to create shell tab: ${e.message}`);
    }
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

  private async diagnose() {
    const lines: string[] = [];
    const folder = this.getVaultFolderPath();
    lines.push(`Vault folder: ${folder}`);
    lines.push(`Singleton workspace ID: ${this.singletonWorkspaceId || '(none)'}`);
    lines.push(`Socket: ${this.client.getSocketPath()}`);
    lines.push(`Available: ${this.client.isAvailable()}`);
    try {
      const snap = await this.client.snapshot();
      lines.push(`Snapshot: OK (Agents: ${snap.agents.length}, Workspaces: ${snap.workspaces.length})`);
      const convs = this.resolver.buildConversations(snap, folder);
      lines.push(`Vault Conversations: ${convs.length}`);
      for (const c of convs) {
        lines.push(` - [${c.status}] ${c.label} (${c.tab_id} -> ${c.pane_id})`);
      }
    } catch (e: any) {
      lines.push(`Snapshot failed: ${e.message}`);
    }
    new Notice(lines.join('\n'), 10000);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.initClient();
    this.setupRefresh();
    this.refreshState();
  }
}

class HerdrSettingTab extends PluginSettingTab {
  plugin: HerdrCompanionPlugin;

  constructor(app: App, plugin: HerdrCompanionPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Herdr Companion Settings' });

    new Setting(containerEl)
      .setName('Focus On Blocked')
      .setDesc('Bring terminal view / notify when an agent is blocked waiting for input.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.focusOnBlocked).onChange(async (val) => {
          this.plugin.settings.focusOnBlocked = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Herdr Session Name')
      .setDesc('Leave blank to use the default session, or specify a named session.')
      .addText((text) =>
        text
          .setPlaceholder('(default)')
          .setValue(this.plugin.settings.session)
          .onChange(async (val) => {
            this.plugin.settings.session = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Refresh Interval (seconds)')
      .setDesc('How often to poll Herdr daemon state (in addition to push event socket).')
      .addSlider((slider) =>
        slider
          .setLimits(1, 10, 1)
          .setValue(this.plugin.settings.refreshIntervalSeconds)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.refreshIntervalSeconds = val;
            await this.plugin.saveSettings();
          })
      );
  }
}

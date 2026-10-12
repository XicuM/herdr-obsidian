import { App, Plugin, PluginSettingTab, Setting, Notice, FileSystemAdapter } from 'obsidian';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { HerdrClient, Snapshot } from './herdrClient';
import { AgentResolver, Conversation } from './resolver';
import { AgentAttender, statusEmoji } from './notifier';
import { HerdrSwitcherModal, HarnessPickerModal, ActionItem } from './switcherModal';
import { launchTerminal } from './terminalModal';

interface HerdrSettings {
  focusOnBlocked: boolean;
  session: string;
  terminalApp: string;
  refreshIntervalSeconds: number;
}

const DEFAULT_SETTINGS: HerdrSettings = {
  focusOnBlocked: true,
  session: '', // Empty means default desktop session
  terminalApp: 'default',
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

  async onload() {
    await this.loadSettings();
    this.initClient();

    // Create Status Bar Item
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('herdr-status-bar');
    this.statusBarEl.addEventListener('click', () => {
      this.pickConversation('switch');
    });

    // Add Ribbon Icon
    this.addRibbonIcon('terminal', 'Herdr Switcher', () => {
      this.pickConversation('switch');
    });

    // Add Commands
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
      id: 'focus-workspace',
      name: 'Focus Vault Workspace',
      callback: () => this.focusWorkspace(true)
    });

    this.addCommand({
      id: 'open-terminal',
      name: 'Open Herdr Terminal Window',
      callback: () => this.openTerminal()
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

    // Subscribe to daemon socket events
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
      this.client.focusWorkspace(conv.workspace_id).catch(() => {});
      this.client.focusTab(conv.tab_id).catch(() => {});
    });
  }

  private getVaultFolderPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return os.homedir();
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
      .catch(() => {
        // Will retry on poll
      });
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
    const convs = this.resolver.buildConversations(snapshot, folder);
    this.convByTab = new Map(convs.map((c) => [c.tab_id, c]));
    this.attender.setConversations(convs);
    this.updateStatusBar(convs, true);

    await this.syncHerdrTabLabels(convs, snapshot);

    for (const c of convs) {
      this.attender.handleStatusChange(c.pane_id, c.status);
    }
  }

  private async syncHerdrTabLabels(convs: Conversation[], snapshot: Snapshot) {
    for (const c of convs) {
      const emoji = statusEmoji(c.status);
      const desiredLabel = emoji ? `${emoji} ${c.label}` : c.label;
      const snapTab = (snapshot.tabs || []).find((t) => t.tab_id === c.tab_id);
      if (snapTab && snapTab.label !== desiredLabel) {
        await this.client.renameTab(c.tab_id, desiredLabel);
      }
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
      this.statusBarEl.setAttribute('aria-label', 'No active conversations in this vault. Click to start or switch.');
      return;
    }

    const blocked = convs.filter((c) => c.status === 'blocked');
    const working = convs.filter((c) => c.status === 'working');

    if (blocked.length > 0) {
      this.statusBarEl.addClass('is-blocked');
      this.statusBarEl.createSpan({ text: `🔔 Herdr: ${blocked.map((b) => b.label).join(', ')} blocked` });
      this.statusBarEl.setAttribute('aria-label', `${blocked.length} agent(s) waiting for input. Click to switch.`);
    } else if (working.length > 0) {
      this.statusBarEl.addClass('is-working');
      const labels = convs
        .map((c) => {
          const emoji = statusEmoji(c.status);
          return emoji ? `${emoji} ${c.label}` : c.label;
        })
        .join(' ');
      this.statusBarEl.createSpan({ text: `🔄 Herdr: ${labels}` });
      this.statusBarEl.setAttribute('aria-label', `${working.length} agent(s) working. Click to switch.`);
    } else {
      const labels = convs
        .map((c) => {
          const emoji = statusEmoji(c.status);
          return emoji ? `${emoji} ${c.label}` : c.label;
        })
        .join(' ');
      this.statusBarEl.createSpan({ text: `💻 Herdr: ${labels}` });
      this.statusBarEl.setAttribute('aria-label', `${convs.length} agent(s) active. Click to switch.`);
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
          this.closeConversation(item.conv);
        } else if (item.type === 'focus_workspace') {
          this.focusWorkspace(true);
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

  private async activateConversation(conv: Conversation) {
    this.currentActiveTabId = conv.tab_id;
    try {
      await this.client.focusWorkspace(conv.workspace_id);
      await this.client.focusTab(conv.tab_id);
      new Notice(`Switched to Herdr tab: ${conv.label}`);
    } catch (e: any) {
      new Notice(`Failed to switch: ${e.message}`);
    }
  }

  private async closeConversation(conv: Conversation) {
    try {
      const snap = await this.client.snapshot();
      const wsTabs = (snap.tabs || []).filter((t) => t.workspace_id === conv.workspace_id);
      if (wsTabs.length <= 1) {
        await this.client.createTab(conv.workspace_id, 'shell', true);
      }
      await this.client.closeTab(conv.tab_id);
      new Notice(`Closed conversation: ${conv.label}`);
      this.refreshState();
    } catch (e: any) {
      new Notice(`Failed to close conversation: ${e.message}`);
    }
  }

  private promptNewConversation() {
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
      await this.client.focusWorkspace(workspaceId);

      const tabRes = await this.client.createTab(workspaceId, null, true);
      const paneId = tabRes?.root_pane?.pane_id;
      const tabId = tabRes?.tab?.tab_id;
      if (!paneId || !tabId) {
        new Notice('Could not create conversation pane.');
        return;
      }

      this.currentActiveTabId = tabId;
      await this.client.focusTab(tabId);

      const name = `${kind.replace(/[^a-z0-9_]/g, '_')}_${Date.now().toString(36)}`;
      new Notice(`Starting ${kind} agent...`);
      await this.client.agentStart(name, kind, paneId, [], 45000);
      new Notice(`Agent ${kind} started!`);
      this.refreshState();
    } catch (e: any) {
      new Notice(`Error starting agent: ${e.message}`);
    }
  }

  private async newShellTab() {
    if (!this.client.isAvailable()) {
      new Notice('Herdr is not running.');
      return;
    }
    const folder = this.getVaultFolderPath();
    try {
      const snap = await this.client.snapshot();
      const workspaceId = await this.resolver.ensureWorkspace(folder, snap);
      await this.client.focusWorkspace(workspaceId);
      const tabRes = await this.client.createTab(workspaceId, 'shell', true);
      if (tabRes?.tab?.tab_id) {
        this.currentActiveTabId = tabRes.tab.tab_id;
        await this.client.focusTab(tabRes.tab.tab_id);
        new Notice('Created new shell tab.');
      }
      this.refreshState();
    } catch (e: any) {
      new Notice(`Failed to create shell tab: ${e.message}`);
    }
  }

  private async focusWorkspace(notify = false) {
    if (!this.client.isAvailable()) return;
    const folder = this.getVaultFolderPath();
    try {
      const snap = await this.client.snapshot();
      const wsId = await this.resolver.ensureWorkspace(folder, snap);
      if (wsId) {
        await this.client.focusWorkspace(wsId);
        if (notify) new Notice('Herdr workspace focused.');
      }
      this.refreshState();
    } catch (e: any) {
      if (notify) new Notice(`Failed to focus workspace: ${e.message}`);
    }
  }

  private openTerminal() {
    const folder = this.getVaultFolderPath();
    const sessionArg = this.settings.session ? `--session "${this.settings.session}"` : '';
    const configPath = this.settings.session
      ? path.join(os.homedir(), '.config', 'herdr', 'sessions', this.settings.session, 'config.toml')
      : path.join(os.homedir(), '.config', 'herdr', 'config.toml');
    const configEnv = fs.existsSync(configPath) ? `HERDR_CONFIG_PATH="${configPath}" ` : '';
    const cmd = `cd "${folder}" && env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID ${configEnv}herdr ${sessionArg}`.trim();

    launchTerminal(this.app, cmd, folder, this.settings.terminalApp);
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
    lines.push(`Socket: ${this.client.getSocketPath()}`);
    lines.push(`Available: ${this.client.isAvailable()}`);
    try {
      const snap = await this.client.snapshot();
      lines.push(`Snapshot: OK (Agents: ${snap.agents.length}, Workspaces: ${snap.workspaces.length})`);
      const convs = this.resolver.buildConversations(snap, folder);
      lines.push(`Vault Conversations: ${convs.length}`);
      for (const c of convs) {
        lines.push(` - [${c.status}] ${c.label} (${c.tab_id})`);
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
      .setDesc('Bring tab / notify when an agent is blocked waiting for input.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.focusOnBlocked).onChange(async (val) => {
          this.plugin.settings.focusOnBlocked = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Herdr Session Name')
      .setDesc('Leave blank to use the default session (shared with your desktop/CLI), or specify a named session.')
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
      .setName('Terminal Launcher')
      .setDesc('Terminal command to launch Herdr TUI (e.g., "alacritty", "kitty", "foot", or "default").')
      .addText((text) =>
        text
          .setPlaceholder('default')
          .setValue(this.plugin.settings.terminalApp)
          .onChange(async (val) => {
            this.plugin.settings.terminalApp = val.trim();
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

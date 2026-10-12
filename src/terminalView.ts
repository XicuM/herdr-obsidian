import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Conversation } from './resolver';
import { HerdrTerminalStream } from './terminalStream';
import { statusEmoji } from './notifier';
import { HARNESS_KINDS } from './herdrClient';
import type HerdrCompanionPlugin from './main';

export const HERDR_VIEW_TYPE = 'herdr-companion-terminal-view';

export class HerdrTerminalView extends ItemView {
  private plugin: HerdrCompanionPlugin;
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private stream: HerdrTerminalStream | null = null;
  private currentPaneId: string | null = null;
  private currentTabId: string | null = null;

  private tabBarEl!: HTMLElement;
  private terminalContainerEl!: HTMLElement;
  private resizeObserver!: ResizeObserver;

  constructor(leaf: WorkspaceLeaf, plugin: HerdrCompanionPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return HERDR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Herdr Agents';
  }

  getIcon(): string {
    return 'terminal';
  }

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.addClass('herdr-view-container');

    // Tab bar along the top
    this.tabBarEl = container.createDiv({ cls: 'herdr-tab-bar' });

    // Terminal host container
    this.terminalContainerEl = container.createDiv({ cls: 'herdr-terminal-container' });

    this.initTerminal();

    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(this.terminalContainerEl);

    // Initial render of tabs
    this.renderTabs();
  }

  async onClose() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.detachStream();
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }
  }

  private initTerminal() {
    this.terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'monospace',
      fontSize: 13,
      theme: {
        background: '#141414',
        foreground: '#e0e0e0',
        cursor: '#f0f0f0',
        selectionBackground: 'rgba(255, 255, 255, 0.3)'
      },
      allowProposedApi: true
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    this.terminal.open(this.terminalContainerEl);

    this.terminal.onData((data) => {
      this.stream?.sendInput(data);
    });

    this.terminal.onBinary((data) => {
      this.stream?.sendInput(data);
    });

    setTimeout(() => {
      this.handleResize();
    }, 50);
  }

  private handleResize() {
    if (!this.fitAddon || !this.terminal || !this.terminalContainerEl) return;
    try {
      this.fitAddon.fit();
      if (this.stream) {
        this.stream.resize(this.terminal.cols, this.terminal.rows);
      }
    } catch {}
  }

  public renderTabs() {
    if (!this.tabBarEl) return;
    this.tabBarEl.empty();

    const convs = this.plugin.getConversations();

    // If there are conversations and none is active, pick the first one
    if (convs.length > 0 && !this.currentTabId) {
      this.currentTabId = convs[0].tab_id;
      this.currentPaneId = convs[0].pane_id;
      this.attachToPane(convs[0].pane_id);
    }

    if (convs.length === 0) {
      const emptyItem = this.tabBarEl.createDiv({ cls: 'herdr-tab-item' });
      emptyItem.createSpan({ text: 'No agent tabs' });
    }

    for (const c of convs) {
      const tabEl = this.tabBarEl.createDiv({
        cls: `herdr-tab-item ${c.tab_id === this.currentTabId ? 'is-active' : ''} ${c.status === 'blocked' ? 'is-blocked' : ''}`
      });

      const emoji = statusEmoji(c.status);
      const prefix = emoji ? `${emoji} ` : '';
      const titleSpan = tabEl.createSpan({ text: `${prefix}${c.label}` });

      tabEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('herdr-tab-close')) return;
        this.switchToTab(c);
      });

      const closeBtn = tabEl.createSpan({ cls: 'herdr-tab-close', text: '×' });
      closeBtn.setAttribute('title', 'Close tab');
      closeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.plugin.closeConversationTab(c);
      });
    }

    // Action buttons on the right of the tab bar
    const actionsEl = this.tabBarEl.createDiv({ cls: 'herdr-tab-bar-actions' });

    const newBtn = actionsEl.createEl('button', { cls: 'herdr-action-btn', text: '+' });
    newBtn.setAttribute('title', 'Start new agent conversation');
    newBtn.addEventListener('click', () => {
      this.plugin.promptNewConversation();
    });

    const shellBtn = actionsEl.createEl('button', { cls: 'herdr-action-btn', text: '>_' });
    shellBtn.setAttribute('title', 'Open new shell tab');
    shellBtn.addEventListener('click', () => {
      this.plugin.newShellTab();
    });
  }

  public switchToTab(conv: Conversation) {
    this.currentTabId = conv.tab_id;
    this.currentPaneId = conv.pane_id;
    this.renderTabs();
    this.attachToPane(conv.pane_id);
    this.plugin.focusHerdrTab(conv.tab_id);
  }

  public focusPane(paneId: string) {
    const convs = this.plugin.getConversations();
    const target = convs.find((c) => c.pane_id === paneId);
    if (target) {
      this.switchToTab(target);
    } else {
      this.attachToPane(paneId);
    }
  }

  private detachStream() {
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
  }

  private attachToPane(paneId: string) {
    this.detachStream();

    if (!this.terminal) return;

    // Reset terminal display for new takeover session (like herdr-mobile)
    this.terminal.reset();
    this.terminal.write('\x1b[?1049h\x1b[0m\x1b[H\x1b[2J');
    this.terminal.write(`\r\nConnecting to Herdr pane ${paneId}...\r\n`);

    this.handleResize();
    const cols = this.terminal.cols || 80;
    const rows = this.terminal.rows || 24;

    this.stream = new HerdrTerminalStream(paneId, this.plugin.settings.session, {
      onData: (data) => {
        this.terminal?.write(data);
      },
      onExit: (code) => {
        this.terminal?.write(`\r\n[Herdr stream closed (code ${code})]\r\n`);
      },
      onError: (err) => {
        this.terminal?.write(`\r\n\x1b[31m[Herdr Error: ${err}]\x1b[0m\r\n`);
      }
    });

    this.stream.start(cols, rows);
  }
}

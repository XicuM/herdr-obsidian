import { ItemView, WorkspaceLeaf, Menu } from 'obsidian';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Conversation } from './resolver';
import { HerdrTerminalStream } from './terminalStream';
import { getTerminalTheme } from './terminalTheme';
import { RenameTabModal } from './renameModal';
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
  private themeObserver!: MutationObserver;

  constructor(leaf: WorkspaceLeaf, plugin: HerdrCompanionPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return HERDR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Herdr';
  }

  getIcon(): string {
    return 'terminal';
  }

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.addClass('herdr-view-container');

    this.tabBarEl = container.createDiv({ cls: 'herdr-tab-bar' });
    this.terminalContainerEl = container.createDiv({ cls: 'herdr-terminal-container' });

    this.initTerminal();

    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(this.terminalContainerEl);

    // Watch Obsidian theme changes (light/dark toggle)
    this.themeObserver = new MutationObserver(() => {
      this.applyTheme();
    });
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    this.renderTabs();
  }

  async onClose() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.themeObserver) {
      this.themeObserver.disconnect();
    }
    this.detachStream();
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }
  }

  public applyTheme() {
    if (!this.terminal) return;
    const theme = getTerminalTheme(this.plugin.settings.themeMode);
    this.terminal.options.theme = theme;
  }

  private initTerminal() {
    const theme = getTerminalTheme(this.plugin.settings.themeMode);

    this.terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'var(--font-monospace)',
      fontSize: this.plugin.settings.fontSize || 13,
      theme,
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

    // Auto-select first tab if none active
    if (convs.length > 0 && (!this.currentTabId || !convs.some((c) => c.tab_id === this.currentTabId))) {
      this.currentTabId = convs[0].tab_id;
      this.currentPaneId = convs[0].pane_id;
      this.attachToPane(convs[0].pane_id);
    }

    if (convs.length === 0) {
      const emptyItem = this.tabBarEl.createDiv({ cls: 'herdr-tab-item' });
      emptyItem.createSpan({ text: 'No agent tabs' });
    }

    for (const c of convs) {
      const isActive = c.tab_id === this.currentTabId;
      const tabEl = this.tabBarEl.createDiv({
        cls: `herdr-tab-item ${isActive ? 'is-active' : ''}`
      });

      // Status dot
      tabEl.createSpan({ cls: `herdr-status-dot status-${c.status}` });

      // Tab label
      const labelSpan = tabEl.createSpan({ cls: 'herdr-tab-label', text: c.label });
      labelSpan.setAttribute('title', `${c.label} (${c.status})`);

      // Tab selection
      tabEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('herdr-tab-close')) return;
        this.switchToTab(c);
      });

      // Tab context menu (Rename, Close)
      tabEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem((item) => {
          item.setTitle('Rename Tab')
            .setIcon('pencil')
            .onClick(() => {
              new RenameTabModal(this.plugin.app, c.label, (newName) => {
                this.plugin.renameConversationTab(c, newName);
              }).open();
            });
        });
        menu.addItem((item) => {
          item.setTitle('Close Tab')
            .setIcon('trash')
            .onClick(() => {
              this.plugin.closeConversationTab(c);
            });
        });
        menu.showAtMouseEvent(e);
      });

      // Double-click to rename
      labelSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        new RenameTabModal(this.plugin.app, c.label, (newName) => {
          this.plugin.renameConversationTab(c, newName);
        }).open();
      });

      // Close button (x)
      const closeBtn = tabEl.createSpan({ cls: 'herdr-tab-close', text: '×' });
      closeBtn.setAttribute('title', 'Close tab');
      closeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.plugin.closeConversationTab(c);
      });
    }

    // Tab actions on the right (+, >_)
    const actionsEl = this.tabBarEl.createDiv({ cls: 'herdr-tab-bar-actions' });

    const newBtn = actionsEl.createEl('button', { cls: 'herdr-action-btn', text: '+' });
    newBtn.setAttribute('title', 'New agent conversation');
    newBtn.addEventListener('click', () => {
      this.plugin.promptNewConversation();
    });

    const shellBtn = actionsEl.createEl('button', { cls: 'herdr-action-btn', text: '>_' });
    shellBtn.setAttribute('title', 'New shell tab');
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

    this.terminal.reset();
    this.terminal.write('\x1b[?1049h\x1b[0m\x1b[H\x1b[2J');

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

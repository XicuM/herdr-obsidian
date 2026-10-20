import { ItemView, WorkspaceLeaf, Menu, Notice, TFile, setIcon } from 'obsidian';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Conversation } from './resolver';
import { HerdrTerminalStream } from './terminalStream';
import { getTerminalTheme } from './terminalTheme';
import type HerdrPlugin from './main';

export const HERDR_VIEW_TYPE = 'herdr-obsidian-terminal-view';

// Omarchy's universal copy sends SUPER+C into this window as a synthesized Ctrl+C whose Control
// modifier rides on the event itself: no Control key is down, so no Control keydown precedes it.
// A real Ctrl+C always follows a Control keydown, which is what tells the copy gesture apart from
// an interrupt.
let physicalControlHeld = false;
let physicalModifiersTracked = false;

function trackPhysicalModifiers(): void {
  if (physicalModifiersTracked) return;
  physicalModifiersTracked = true;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Control') physicalControlHeld = true;
    else if (!event.ctrlKey) physicalControlHeld = false;
  }, true);
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Control') physicalControlHeld = false;
  }, true);
}

export class HerdrTerminalView extends ItemView {
  private plugin: HerdrPlugin;
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private stream: HerdrTerminalStream | null = null;
  private streamSession = '';
  private streamErrored = false;
  private currentPaneId: string | null = null;
  private currentTabId: string | null = null;

  private tabBarEl!: HTMLElement;
  private terminalContainerEl!: HTMLElement;
  private resizeObserver!: ResizeObserver;
  private themeObserver!: MutationObserver;
  private wheelAccumulator = 0;
  private dragCounter = 0;
  private bgUpdateRaf: number | null = null;
  private currentDetectedBg: string | null = null;
  private onDragEnter: ((e: DragEvent) => void) | null = null;
  private onDragOver: ((e: DragEvent) => void) | null = null;
  private onDragLeave: ((e: DragEvent) => void) | null = null;
  private onDrop: ((e: DragEvent) => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: HerdrPlugin) {
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
    container.style.padding = '0';
    container.style.margin = '0';
    container.style.overflow = 'hidden';

    this.tabBarEl = container.createDiv({ cls: 'herdr-tab-bar' });
    this.terminalContainerEl = container.createDiv({ cls: 'herdr-terminal-container' });

    // Only swallow wheel events when actively streaming remote content.
    // When the stream is down, let the event propagate so native scroll still works.
    this.terminalContainerEl.addEventListener('wheel', (e) => {
      if (this.stream?.isRunning) {
        e.preventDefault();
      }
    }, { passive: false });

    // Drag-and-drop support: drag files or paragraphs directly into the terminal
    this.onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      this.dragCounter++;
      if (this.dragCounter === 1) {
        this.terminalContainerEl.addClass('herdr-drop-active');
      }
    };

    this.onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    };

    this.onDragLeave = () => {
      this.dragCounter--;
      if (this.dragCounter <= 0) {
        this.dragCounter = 0;
        this.terminalContainerEl.removeClass('herdr-drop-active');
      }
    };

    this.onDrop = (e: DragEvent) => {
      e.preventDefault();
      this.dragCounter = 0;
      this.terminalContainerEl.removeClass('herdr-drop-active');
      this.handleDrop(e);
    };

    this.terminalContainerEl.addEventListener('dragenter', this.onDragEnter);
    this.terminalContainerEl.addEventListener('dragover', this.onDragOver);
    this.terminalContainerEl.addEventListener('dragleave', this.onDragLeave);
    this.terminalContainerEl.addEventListener('drop', this.onDrop);

    this.initTerminal();

    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(this.terminalContainerEl);

    // Watch Obsidian theme changes (light/dark toggle + CSS variable updates)
    this.themeObserver = new MutationObserver(() => {
      this.applyTheme();
    });
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });

    this.renderTabs();
  }

  async onClose() {
    if (this.onDragEnter) {
      this.terminalContainerEl.removeEventListener('dragenter', this.onDragEnter);
      this.terminalContainerEl.removeEventListener('dragover', this.onDragOver!);
      this.terminalContainerEl.removeEventListener('dragleave', this.onDragLeave!);
      this.terminalContainerEl.removeEventListener('drop', this.onDrop!);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.themeObserver) {
      this.themeObserver.disconnect();
    }
    if (this.bgUpdateRaf !== null) {
      window.cancelAnimationFrame(this.bgUpdateRaf);
      this.bgUpdateRaf = null;
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
    this.updateDetectedBackground();
  }

  public updateDetectedBackground() {
    if (!this.terminal) return;
    const detected = this.detectTerminalBackground();
    const baseTheme = getTerminalTheme(this.plugin.settings.themeMode);
    const fallback = baseTheme.background || 'var(--background-primary)';
    const effectiveBg = detected || fallback;
    if (effectiveBg !== this.currentDetectedBg) {
      this.currentDetectedBg = effectiveBg;
      this.contentEl.style.setProperty('--herdr-tab-bg', effectiveBg);
      if (this.terminalContainerEl) {
        this.terminalContainerEl.style.backgroundColor = effectiveBg;
      }
      if (this.terminal.options.theme?.background !== effectiveBg) {
        this.terminal.options.theme = {
          ...baseTheme,
          background: effectiveBg
        };
      }
    }
  }

  private paletteIndexToHex(idx: number): string | null {
    if (idx < 0 || idx > 255) return null;
    if (idx >= 16 && idx <= 231) {
      const i = idx - 16;
      const r = Math.floor(i / 36) ? Math.floor(i / 36) * 40 + 55 : 0;
      const g = Math.floor((i % 36) / 6) ? Math.floor((i % 36) / 6) * 40 + 55 : 0;
      const b = (i % 6) ? (i % 6) * 40 + 55 : 0;
      return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }
    if (idx >= 232 && idx <= 255) {
      const gray = (idx - 232) * 10 + 8;
      return '#' + ((1 << 24) + (gray << 16) + (gray << 8) + gray).toString(16).slice(1);
    }
    return null;
  }

  private detectTerminalBackground(): string | null {
    if (!this.terminal) return null;
    const buffer = this.terminal.buffer.active;
    const nullCell = buffer.getNullCell();
    const counts = new Map<string, number>();

    const first = buffer.baseY;
    const lastRow = Math.min(buffer.length - 1, buffer.baseY + this.terminal.rows - 1);

    for (let y = first; y <= lastRow; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const edgeRow = y === first || y === lastRow;
      const lastCol = line.length - 1;

      for (let x = 0; x <= lastCol; x = edgeRow || x === lastCol ? x + 1 : lastCol) {
        line.getCell(x, nullCell);
        if (nullCell.isBgRGB()) {
          const hex = '#' + nullCell.getBgColor().toString(16).padStart(6, '0');
          counts.set(hex, (counts.get(hex) || 0) + 1);
        } else if (nullCell.isBgPalette()) {
          const hex = this.paletteIndexToHex(nullCell.getBgColor());
          if (hex) counts.set(hex, (counts.get(hex) || 0) + 1);
        }
      }
    }

    // If edge rows didn't find any custom background, scan the left column (x=0)
    // for full-screen TUIs whose formatted boxes don't reach the right terminal boundary
    if (counts.size === 0) {
      for (let y = first; y <= lastRow; y++) {
        const line = buffer.getLine(y);
        if (!line) continue;
        line.getCell(0, nullCell);
        if (nullCell.isBgRGB()) {
          const hex = '#' + nullCell.getBgColor().toString(16).padStart(6, '0');
          counts.set(hex, (counts.get(hex) || 0) + 1);
        } else if (nullCell.isBgPalette()) {
          const hex = this.paletteIndexToHex(nullCell.getBgColor());
          if (hex) counts.set(hex, (counts.get(hex) || 0) + 1);
        }
      }
    }

    if (counts.size === 0) return null;
    let topColor: string | null = null;
    let maxCount = 0;
    for (const [color, count] of counts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        topColor = color;
      }
    }
    return topColor;
  }

  public updateSettings() {
    if (!this.terminal) return;
    this.terminal.options.fontSize = this.plugin.settings.fontSize || 14;
    this.terminal.options.lineHeight = 1.1;
    this.applyTheme();
    this.handleResize();
    // Re-attach if the session changed, otherwise the stream keeps talking to the old socket.
    if (this.currentPaneId && this.streamSession !== this.plugin.getSessionName()) {
      this.attachToPane(this.currentPaneId, true);
    }
  }

  private initTerminal() {
    const theme = getTerminalTheme(this.plugin.settings.themeMode);

    this.terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: "ui-monospace, 'Cascadia Code', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: this.plugin.settings.fontSize || 14,
      lineHeight: 1.1,
      scrollback: 1000,
      theme,
      allowProposedApi: true,
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (e: MouseEvent, text: string) => {
          this.openTerminalLink(text, (e.ctrlKey || e.metaKey) ? 'tab' : false);
        }
      }
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    // Detect plain text and markdown file paths in terminal buffer (supporting soft-wrapped lines)
    const FILE_LINK_REGEX = /(?:https?:\/\/[^\s)]+|(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.(?:md|canvas|png|jpg|jpeg|gif|svg|pdf|json|ts|js|py|ya?ml|txt|csv)(?::\d+(?::\d+)?)?)/gi;

    this.terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeBuffer = this.terminal?.buffer.active;
        if (!activeBuffer) return callback(undefined);

        const currentLineIdx = bufferLineNumber - 1; // 0-based
        const currentLine = activeBuffer.getLine(currentLineIdx);
        if (!currentLine) return callback(undefined);

        // Find contiguous logical line bounds (accounting for soft-wrapped lines)
        let startY = currentLineIdx;
        while (startY > 0 && activeBuffer.getLine(startY)?.isWrapped) {
          startY--;
        }

        let endY = currentLineIdx;
        while (endY + 1 < activeBuffer.length && activeBuffer.getLine(endY + 1)?.isWrapped) {
          endY++;
        }

        // Map characters across all wrapped lines back to their 1-based buffer coordinates
        interface CharCoord { x: number; y: number }
        const charCoords: CharCoord[] = [];
        let logicalText = '';

        for (let y = startY; y <= endY; y++) {
          const lineObj = activeBuffer.getLine(y);
          if (!lineObj) continue;

          const outColumns: number[] = [];
          const lineStr = (lineObj as any).translateToString(true, 0, undefined, outColumns);

          for (let i = 0; i < lineStr.length; i++) {
            const col = outColumns[i] !== undefined ? outColumns[i] : i;
            charCoords.push({ x: col + 1, y: y + 1 });
          }
          logicalText += lineStr;
        }

        if (!logicalText) return callback(undefined);

        const links = [];
        let match: RegExpExecArray | null;
        FILE_LINK_REGEX.lastIndex = 0;

        while ((match = FILE_LINK_REGEX.exec(logicalText)) !== null) {
          const matchText = match[0];
          const startIdx = match.index;
          const endIdx = startIdx + matchText.length - 1;

          const startCoord = charCoords[startIdx];
          const endCoord = charCoords[endIdx];

          if (!startCoord || !endCoord) continue;

          // Only return links intersecting the requested bufferLineNumber
          if (startCoord.y <= bufferLineNumber && bufferLineNumber <= endCoord.y) {
            links.push({
              text: matchText,
              range: {
                start: { x: startCoord.x, y: startCoord.y },
                end: { x: endCoord.x, y: endCoord.y }
              },
              activate: (e: MouseEvent, targetText: string) => {
                this.openTerminalLink(targetText, (e.ctrlKey || e.metaKey) ? 'tab' : false);
              }
            });
          }
        }
        callback(links);
      }
    });

    this.terminal.open(this.terminalContainerEl);

    this.terminal.attachCustomWheelEventHandler((event: WheelEvent) => {
      if (!this.stream?.isRunning) return true;

      let delta = event.deltaY;
      if (event.deltaMode === 1) {
        delta *= 25; // Line mode
      } else if (event.deltaMode === 2) {
        delta *= 400; // Page mode
      }

      this.wheelAccumulator += delta;
      const threshold = 25;

      if (Math.abs(this.wheelAccumulator) >= threshold) {
        const lines = Math.max(1, Math.floor(Math.abs(this.wheelAccumulator) / threshold));
        const direction = this.wheelAccumulator < 0 ? 'up' : 'down';
        this.wheelAccumulator = this.wheelAccumulator % threshold;
        this.stream.scroll(direction, lines);
      }

      return false;
    });

    trackPhysicalModifiers();

    this.terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      // Ctrl+C copies a selection, as in VS Code's terminal. Omarchy's SUPER+C arrives as a
      // synthesized Ctrl+C, so without this a copy gesture would interrupt the remote pane.
      const isCopyChord = (event.key === 'c' || event.key === 'C' || event.code === 'KeyC') &&
        (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
      if (event.type === 'keydown' && isCopyChord) {
        if (this.terminal?.hasSelection()) {
          void navigator.clipboard.writeText(this.terminal.getSelection());
          event.preventDefault();
          return false;
        }
        // Nothing selected: SUPER+C is still a copy gesture, so it must not interrupt. Only a
        // real Ctrl+C, with the Control key physically down, is allowed through as SIGINT.
        if (!physicalControlHeld) {
          event.preventDefault();
          return false;
        }
      }

      // Omarchy's SUPER+V arrives the same way, and left alone it lands in the pane as a literal
      // ^V. Paste the clipboard instead, the way SUPER+V does everywhere else.
      const isPasteChord = (event.key === 'v' || event.key === 'V' || event.code === 'KeyV') &&
        (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
      if (event.type === 'keydown' && isPasteChord && !physicalControlHeld) {
        event.preventDefault();
        void navigator.clipboard.readText().then((text) => {
          if (text) this.terminal?.paste(text);
        });
        return false;
      }

      // Shift+PageUp/PageDown scroll the remote pane. Shift+Arrow is intentionally
      // left alone so xterm text selection keeps working.
      if (event.type === 'keydown' && this.stream?.isRunning) {
        if (event.shiftKey) {
          if (event.key === 'PageUp') {
            const lines = Math.max(1, Math.floor((this.terminal?.rows || 24) / 2));
            this.stream.scroll('up', lines);
            return false;
          }
          if (event.key === 'PageDown') {
            const lines = Math.max(1, Math.floor((this.terminal?.rows || 24) / 2));
            this.stream.scroll('down', lines);
            return false;
          }
        }
      }
      return true;
    });

    this.terminal.onData((data) => {
      this.stream?.sendInput(data);
    });

    this.terminal.onBinary((data) => {
      this.stream?.sendInput(data);
    });

    this.terminal.onWriteParsed(() => {
      if (this.bgUpdateRaf === null) {
        this.bgUpdateRaf = window.requestAnimationFrame(() => {
          this.bgUpdateRaf = null;
          this.updateDetectedBackground();
        });
      }
    });

    this.updateDetectedBackground();

    setTimeout(() => {
      this.handleResize();
    }, 50);
  }

  private handleResize() {
    if (!this.terminal || !this.terminalContainerEl) return;
    try {
      const core = (this.terminal as any)._core;
      const dims = core?._renderService?.dimensions;
      if (dims && dims.css.cell.width > 0 && dims.css.cell.height > 0) {
        const width = this.terminalContainerEl.clientWidth;
        const height = this.terminalContainerEl.clientHeight;
        const cols = Math.max(10, Math.floor(width / dims.css.cell.width));
        const rows = Math.max(5, Math.floor(height / dims.css.cell.height));
        if (this.terminal.cols !== cols || this.terminal.rows !== rows) {
          core._renderService.clear();
          this.terminal.resize(cols, rows);
        }
      } else if (this.fitAddon) {
        this.fitAddon.fit();
      }
      if (this.stream) {
        this.stream.resize(this.terminal.cols, this.terminal.rows);
      }
    } catch {}
  }

  private openTerminalLink(raw: string, newLeaf: boolean | 'tab') {
    let target = raw.trim();
    if (target.startsWith('file://')) {
      try {
        target = decodeURIComponent(new URL(target).pathname);
      } catch {
        target = target.replace(/^file:\/\//, '');
      }
      const vaultPath = this.plugin.getVaultFolderPath();
      if (vaultPath && target.startsWith(vaultPath)) {
        target = target.slice(vaultPath.length).replace(/^[/\\]+/, '');
      }
    } else if (/^https?:\/\//i.test(target)) {
      window.open(target);
      return;
    }

    let clean = target.replace(/^[*_`"'(<[]+|[*_`"')>:,\]]+$/g, '');
    let lineNumber: number | undefined;
    const lineMatch = clean.match(/^(.+?):(\d+)(?::\d+)?$/);
    if (lineMatch) {
      clean = lineMatch[1];
      lineNumber = parseInt(lineMatch[2], 10);
    }

    if (clean) {
      const openState = lineNumber !== undefined ? { eState: { line: Math.max(0, lineNumber - 1) } } : undefined;
      this.plugin.app.workspace.openLinkText(clean, '', newLeaf, openState);
    }
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
      const emptyWrap = this.tabBarEl.createDiv({ cls: 'herdr-tab-empty' });
      emptyWrap.createSpan({ text: 'No agent tabs' });
      const newAgentBtn = emptyWrap.createEl('button', { cls: 'herdr-empty-btn', text: 'New agent' });
      newAgentBtn.setAttribute('aria-label', 'Start a new agent conversation');
      newAgentBtn.addEventListener('click', () => this.plugin.promptNewConversation());
      const newShellBtn = emptyWrap.createEl('button', { cls: 'herdr-empty-btn', text: 'New shell' });
      newShellBtn.setAttribute('aria-label', 'Open a new shell tab');
      newShellBtn.addEventListener('click', () => this.plugin.newShellTab());
      return;
    }

    const listEl = this.tabBarEl.createDiv({ cls: 'herdr-tab-list' });

    // Enable horizontal scroll on mouse wheel over tab list
    listEl.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0 && listEl.scrollWidth > listEl.clientWidth) {
        e.preventDefault();
        listEl.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    for (const c of convs) {
      const isActive = c.tab_id === this.currentTabId;
      const tabEl = listEl.createDiv({
        cls: `herdr-tab-item ${isActive ? 'is-active' : ''}`
      });

      const innerEl = tabEl.createDiv({ cls: 'herdr-tab-inner' });

      // Status dot (color + shape + text alternative for colorblind users)
      const dotWrap = innerEl.createDiv({ cls: 'herdr-tab-status' });
      const dot = dotWrap.createSpan({ cls: `herdr-status-dot status-${c.status}` });
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', `Status: ${c.status}`);

      // Tab label
      const labelSpan = innerEl.createDiv({ cls: 'herdr-tab-label', text: c.label });

      // Close button (x) — native clickable-icon styling with Lucide 'x'
      const closeBtn = innerEl.createDiv({ cls: 'herdr-tab-close clickable-icon' });
      closeBtn.setAttribute('role', 'button');
      closeBtn.setAttribute('aria-label', `Close ${c.label}`);
      setIcon(closeBtn, 'x');

      closeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.plugin.closeConversationTab(c);
      });

      tabEl.setAttribute('role', 'tab');
      tabEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tabEl.setAttribute('aria-label', `${c.label}, ${c.status}${isActive ? ', active' : ''}`);
      tabEl.setAttribute('tabindex', '0');

      // Keyboard activation (Enter/Space) and Arrow navigation for a11y
      tabEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.switchToTab(c);
        } else if (e.key === 'ArrowRight') {
          const next = tabEl.nextElementSibling as HTMLElement | null;
          if (next && next.classList.contains('herdr-tab-item')) {
            e.preventDefault();
            next.focus();
          }
        } else if (e.key === 'ArrowLeft') {
          const prev = tabEl.previousElementSibling as HTMLElement | null;
          if (prev && prev.classList.contains('herdr-tab-item')) {
            e.preventDefault();
            prev.focus();
          }
        }
      });

      // Tab selection
      tabEl.addEventListener('click', (e) => {
        if (closeBtn.contains(e.target as Node)) return;
        this.switchToTab(c);
      });

      // Drag-and-drop tab reordering
      tabEl.setAttribute('draggable', 'true');

      tabEl.addEventListener('dragstart', (e) => {
        if (e.dataTransfer) {
          e.dataTransfer.setData('text/plain', c.tab_id);
          e.dataTransfer.effectAllowed = 'move';
        }
        tabEl.addClass('is-dragging');
      });

      tabEl.addEventListener('dragend', () => {
        tabEl.removeClass('is-dragging');
        listEl.querySelectorAll('.herdr-tab-item').forEach((el) => {
          el.removeClass('drop-target-left');
          el.removeClass('drop-target-right');
        });
      });

      tabEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'move';
        }
        const rect = tabEl.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        if (e.clientX < midX) {
          tabEl.addClass('drop-target-left');
          tabEl.removeClass('drop-target-right');
        } else {
          tabEl.addClass('drop-target-right');
          tabEl.removeClass('drop-target-left');
        }
      });

      tabEl.addEventListener('dragleave', () => {
        tabEl.removeClass('drop-target-left');
        tabEl.removeClass('drop-target-right');
      });

      tabEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        const fromTabId = e.dataTransfer?.getData('text/plain');
        tabEl.removeClass('drop-target-left');
        tabEl.removeClass('drop-target-right');
        if (!fromTabId || fromTabId === c.tab_id) return;

        const rect = tabEl.getBoundingClientRect();
        const isBefore = e.clientX < rect.left + rect.width / 2;
        await this.plugin.reorderTab(fromTabId, c.tab_id, isBefore);
      });

      // Middle click to close tab (matches Obsidian tab behavior)
      tabEl.addEventListener('auxclick', async (e) => {
        if (e.button === 1) {
          e.preventDefault();
          await this.plugin.closeConversationTab(c);
        }
      });

      // Tab context menu (Rename, Close)
      tabEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem((item) => {
          item.setTitle('Rename Tab')
            .setIcon('pencil')
            .onClick(() => {
              this.plugin.promptRename(c);
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
      innerEl.addEventListener('dblclick', (e) => {
        if (closeBtn.contains(e.target as Node)) return;
        e.stopPropagation();
        this.plugin.promptRename(c);
      });

      if (isActive) {
        tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }

    // Tab action on the right: native new-tab button with Lucide 'plus'
    const actionsEl = this.tabBarEl.createDiv({ cls: 'herdr-tab-actions' });
    const addTabBtn = actionsEl.createDiv({ cls: 'herdr-action-btn clickable-icon' });
    addTabBtn.setAttribute('role', 'button');
    addTabBtn.setAttribute('aria-label', 'New terminal tab');
    setIcon(addTabBtn, 'plus');
    addTabBtn.addEventListener('click', () => {
      this.plugin.newShellTab();
    });
  }

  public switchToTab(conv: Conversation) {
    const streamAlive = !!this.stream?.isRunning && !this.streamErrored;
    const isSameTab = this.currentTabId === conv.tab_id && this.currentPaneId === conv.pane_id;
    if (isSameTab && streamAlive) {
      this.plugin.focusHerdrTab(conv.tab_id);
      return;
    }
    // Same tab but stream dead/errored (e.g. takeover): force re-attach.
    this.currentTabId = conv.tab_id;
    this.currentPaneId = conv.pane_id;
    this.currentDetectedBg = null;
    this.renderTabs();
    this.updateDetectedBackground();
    this.attachToPane(conv.pane_id, true);
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

  private attachToPane(paneId: string, force = true) {
    if (!force && this.currentPaneId === paneId && this.stream?.isRunning) {
      return;
    }
    this.currentPaneId = paneId;
    this.streamSession = this.plugin.getSessionName();
    this.streamErrored = false;
    this.wheelAccumulator = 0;
    this.detachStream();

    if (!this.terminal) return;

    this.terminal.reset();
    this.terminal.write('\x1b[?1049h\x1b[0m\x1b[H\x1b[2J');

    this.handleResize();
    const cols = this.terminal.cols || 80;
    const rows = this.terminal.rows || 24;

    this.stream = new HerdrTerminalStream(paneId, this.plugin.getSessionName(), {
      onData: (data) => {
        this.terminal?.write(data);
      },
      onExit: (code) => {
        this.streamErrored = true;
        this.terminal?.write(`\r\n[Herdr stream closed (code ${code}) — click the tab to reconnect]\r\n`);
      },
      onError: (err) => {
        this.streamErrored = true;
        if (err.includes('taken over')) {
          this.terminal?.write(`\r\n\x1b[33m[Herdr: Terminal session taken over by another client. Click this tab to re-attach]\x1b[0m\r\n`);
        } else {
          this.terminal?.write(`\r\n\x1b[31m[Herdr Error: ${err}]\x1b[0m\r\n`);
        }
      }
    });

    this.stream.start(cols, rows);
  }

  private handleDrop(e: DragEvent) {
    if (!this.stream?.isRunning) {
      new Notice('No active Herdr terminal tab to drop into.');
      return;
    }

    const payload = this.resolveDropPayload(e);
    if (!payload) return;

    this.stream.sendInput(payload);
    this.terminal?.focus();
  }

  private resolveDropPayload(e: DragEvent): string | null {
    const agent = this.plugin.getConversations().find((c) => c.tab_id === this.currentTabId)?.agent ?? null;
    const formatPath = (p: string) => {
      const quoted = p.includes(' ') ? `"${p}"` : p;
      if (!this.plugin.settings.addAtPrefixOnDrop || !agent) return `${quoted} `;

      switch (agent) {
        // Codex's @ menu inserts a bare path; the @ is only the trigger character.
        case 'codex':
          return `${quoted} `;
        // These agents insert @ followed by the unquoted path.
        case 'agy':
        case 'copilot':
        case 'grok':
        case 'opencode':
          return `@${p} `;
        // Claude, pi, and unknown harnesses quote paths that contain spaces.
        default:
          return `@${quoted} `;
      }
    };

    // 1. Check Obsidian's internal DragManager (dragging from File Explorer)
    const dragManager = (this.plugin.app as any).dragManager;
    const draggable = dragManager?.draggable;
    if (draggable) {
      if (draggable.type === 'file' && draggable.file?.path) {
        return formatPath(draggable.file.path);
      }
      if (draggable.type === 'files' && Array.isArray(draggable.files)) {
        const paths = draggable.files
          .filter((f: any) => f?.path)
          .map((f: any) => formatPath(f.path));
        if (paths.length > 0) return paths.join('');
      }
    }

    // 2. Check native OS file drops (dragged from OS file manager / desktop)
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      const vaultPath = this.plugin.getVaultFolderPath();
      const parts: string[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i];
        const absPath = (file as any).path;
        if (absPath) {
          let finalPath = absPath;
          if (vaultPath && absPath.startsWith(vaultPath)) {
            finalPath = absPath.slice(vaultPath.length).replace(/^[/\\]+/, '');
          }
          parts.push(formatPath(finalPath));
        }
      }
      if (parts.length > 0) {
        return parts.join('');
      }
    }

    // 3. Check plain text (dragged selection from editor or reading view)
    const text = e.dataTransfer?.getData('text/plain');
    if (text) {
      // Check if it's an internal Obsidian wikilink: [[Target]] or [[Target#Heading]] or [[Target|Alias]]
      const linkMatch = text.match(/^\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]+)?\]\]$/);
      if (linkMatch) {
        const linkTarget = linkMatch[1];
        const subpath = linkMatch[2];
        const dest = this.plugin.app.metadataCache.getFirstLinkpathDest(linkTarget, '');
        if (dest instanceof TFile) {
          const fileRef = subpath ? `${dest.path}#${subpath}` : dest.path;
          return formatPath(fileRef);
        }
        const fallback = linkTarget.endsWith('.md') ? linkTarget : `${linkTarget}.md`;
        const fileRef = subpath ? `${fallback}#${subpath}` : fallback;
        return formatPath(fileRef);
      }

      // Raw text / paragraph: wrap in bracketed paste if multiline to avoid premature execution
      if (text.includes('\n') || text.includes('\r')) {
        return `\x1b[200~${text}\x1b[201~`;
      }
      return text;
    }

    return null;
  }
}

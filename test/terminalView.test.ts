// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TFile, TFolder, notices } from 'obsidian';
import { HerdrTerminalView } from '../src/terminalView';

let plugin: any;
let view: any; // private methods are exercised directly

beforeEach(() => {
  notices.length = 0;
  plugin = {
    settings: { addAtPrefixOnDrop: true },
    getVaultFolderPath: () => '/home/u/vault',
    getConversations: () => [{ tab_id: 't1', agent: 'claude' }],
    app: {
      workspace: { openLinkText: vi.fn() },
      metadataCache: { getFirstLinkpathDest: vi.fn(() => null) }
    }
  };
  view = new HerdrTerminalView({} as any, plugin);
  view.currentTabId = 't1';
});

const drop = (data: { text?: string; files?: string[] } = {}) =>
  ({
    dataTransfer: {
      files: (data.files || []).map((p) => ({ path: p })),
      getData: () => data.text || ''
    }
  }) as any;

describe('openTerminalLink', () => {
  const open = () => plugin.app.workspace.openLinkText;

  it('opens vault-relative paths with line numbers', () => {
    view.openTerminalLink('`src/main.ts:42:7`,', false);
    expect(open()).toHaveBeenCalledWith('src/main.ts', '', false, { eState: { line: 41 } });
  });

  it('strips the vault prefix from file:// URLs', () => {
    view.openTerminalLink('file:///home/u/vault/My%20Note.md', 'tab');
    expect(open()).toHaveBeenCalledWith('My Note.md', '', 'tab', undefined);
  });

  it('sends http(s) links to the browser', () => {
    const winOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    view.openTerminalLink('https://example.com/a', false);
    expect(winOpen).toHaveBeenCalledWith('https://example.com/a');
    expect(open()).not.toHaveBeenCalled();
  });
});

describe('resolveDropPayload', () => {
  it('drops files from the file explorer with the agent @ prefix, quoting spaces', () => {
    plugin.app.dragManager = { draggable: { type: 'files', files: [{ path: 'a.md' }, { path: 'my note.md' }] } };
    expect(view.resolveDropPayload(drop())).toBe('@a.md @"my note.md" ');
  });

  it('drops folders with trailing slashes from the file explorer', () => {
    plugin.app.dragManager = { draggable: { type: 'folder', folder: { path: 'docs' } } };
    expect(view.resolveDropPayload(drop())).toBe('@docs/ ');

    plugin.app.dragManager = { draggable: { type: 'folder', file: { path: 'notes/my folder' } } };
    expect(view.resolveDropPayload(drop())).toBe('@"notes/my folder/" ');

    plugin.app.dragManager = { draggable: { type: 'folders', folders: [{ path: 'docs' }, { path: 'notes/' }] } };
    expect(view.resolveDropPayload(drop())).toBe('@docs/ @notes/ ');

    plugin.app.dragManager = { draggable: { type: 'files', files: [{ path: 'a.md' }, new TFolder('docs')] } };
    expect(view.resolveDropPayload(drop())).toBe('@a.md @docs/ ');
  });

  it.each([
    ['codex', '"my note.md" '],
    ['opencode', '@my note.md '],
    ['pi', '@"my note.md" ']
  ])('uses the %s @-mention style', (agent, expected) => {
    plugin.getConversations = () => [{ tab_id: 't1', agent }];
    plugin.app.dragManager = { draggable: { type: 'file', file: { path: 'my note.md' } } };
    expect(view.resolveDropPayload(drop())).toBe(expected);
  });

  it('drops bare paths in shell tabs or when the prefix is disabled', () => {
    plugin.app.dragManager = { draggable: { type: 'file', file: { path: 'a.md' } } };
    plugin.getConversations = () => [{ tab_id: 't1', agent: null }];
    expect(view.resolveDropPayload(drop())).toBe('a.md ');
    plugin.getConversations = () => [{ tab_id: 't1', agent: 'claude' }];
    plugin.settings.addAtPrefixOnDrop = false;
    expect(view.resolveDropPayload(drop())).toBe('a.md ');
  });

  it('ignores files dropped from the OS: their path is only an Electron extra, gone since Electron 32', () => {
    expect(view.resolveDropPayload(drop({ files: ['/home/u/vault/x/y.md'] }))).toBeNull();
  });

  it('resolves dragged wikilinks, keeping the heading', () => {
    const f = new TFile('notes/Target.md', 0);
    plugin.app.metadataCache.getFirstLinkpathDest = vi.fn(() => f);
    expect(view.resolveDropPayload(drop({ text: '[[Target#Intro|alias]]' }))).toBe('@notes/Target.md#Intro ');
    const folder = new TFolder('notes/sub');
    plugin.app.metadataCache.getFirstLinkpathDest = vi.fn(() => folder);
    expect(view.resolveDropPayload(drop({ text: '[[sub]]' }))).toBe('@notes/sub/ ');
    plugin.app.metadataCache.getFirstLinkpathDest = vi.fn(() => null);
    expect(view.resolveDropPayload(drop({ text: '[[Missing]]' }))).toBe('@Missing.md ');
  });

  it('bracket-pastes multi-line text and passes single lines through', () => {
    expect(view.resolveDropPayload(drop({ text: 'a\nb' }))).toBe('\x1b[200~a\nb\x1b[201~');
    expect(view.resolveDropPayload(drop({ text: 'hello' }))).toBe('hello');
    expect(view.resolveDropPayload(drop())).toBeNull();
  });
});

describe('handleDrop', () => {
  it('needs a running stream', () => {
    view.handleDrop(drop({ text: 'x' }));
    expect(notices).toEqual(['No active herdr terminal tab to drop into.']);
  });

  it('types the payload into the stream', () => {
    view.stream = { isRunning: true, sendInput: vi.fn() };
    view.handleDrop(drop({ text: 'hello' }));
    expect(view.stream.sendInput).toHaveBeenCalledWith('hello');
  });

  it.each([
    ['claude', 'n.md', 3, 5, '@n.md#L3-5 '],
    ['claude', 'my n.md', 3, 3, '@"my n.md#L3" '],
    ['opencode', 'n.md', 3, 5, '@n.md#L3-5 '],
    ['copilot', 'n.md', 3, 5, '@n.md:3-5 '],
    ['codex', 'my n.md', 3, 5, '"my n.md":3-5 '],
    ['pi', 'my n.md', 3, 5, '@"my n.md":3-5 ']
  ])('references a %s selection in its own syntax', (agent, path, start, end, expected) => {
    plugin.getConversations = () => [{ tab_id: 't1', agent }];
    view.stream = { isRunning: true, sendInput: vi.fn() };
    view.sendReference(path, start, end);
    expect(view.stream.sendInput).toHaveBeenCalledWith(expected);
  });
});

describe('paletteIndexToHex', () => {
  it.each([
    [16, '#000000'],
    [21, '#0000ff'],
    [196, '#ff0000'],
    [231, '#ffffff'],
    [232, '#080808'],
    [255, '#eeeeee'],
    [7, null],
    [256, null]
  ])('maps xterm index %i to %s', (idx, hex) => {
    expect(view.paletteIndexToHex(idx)).toBe(hex);
  });
});

describe('suspend/resume', () => {
  it('drops the stream in the background and re-attaches the same pane on return', () => {
    const stream = { close: vi.fn() };
    view.stream = stream;
    view.currentPaneId = 'w1:p1';
    view.attachToPane = vi.fn();
    view.suspend();
    expect(stream.close).toHaveBeenCalled();
    expect(view.stream).toBeNull();
    view.resume();
    expect(view.attachToPane).toHaveBeenCalledWith('w1:p1', true);
  });
});

function createMockEl(): any {
  const enhance = (target: any) => {
    target.empty = () => { target.innerHTML = ''; };
    target.scrollIntoView = () => {};
    target.createDiv = (opts?: { cls?: string; text?: string }) => {
      const child = document.createElement('div');
      if (opts?.cls) child.className = opts.cls;
      if (opts?.text) child.textContent = opts.text;
      enhance(child);
      target.appendChild(child);
      return child;
    };
    target.createSpan = (opts?: { cls?: string; text?: string }) => {
      const child = document.createElement('span');
      if (opts?.cls) child.className = opts.cls;
      if (opts?.text) child.textContent = opts.text;
      enhance(child);
      target.appendChild(child);
      return child;
    };
    target.createEl = (tag: string, opts?: { cls?: string; text?: string }) => {
      const child = document.createElement(tag);
      if (opts?.cls) child.className = opts.cls;
      if (opts?.text) child.textContent = opts.text;
      enhance(child);
      target.appendChild(child);
      return child;
    };
    return target;
  };
  return enhance(document.createElement('div'));
}

describe('renderTabs', () => {
  it('plus button opens a new terminal tab without prompt', () => {
    plugin.newShellTab = vi.fn();
    plugin.promptNewConversation = vi.fn();
    plugin.wantsSkillOffer = vi.fn(() => false);
    view.tabBarEl = createMockEl();
    view.renderTabs();
    const plusBtn = view.tabBarEl.querySelector('.herdr-tab-actions .herdr-action-btn') as HTMLElement;
    expect(plusBtn).toBeTruthy();
    plusBtn.click();
    expect(plugin.newShellTab).toHaveBeenCalledTimes(1);
    expect(plugin.promptNewConversation).not.toHaveBeenCalled();
  });

  it('plus button is also present when conversations list is empty', () => {
    plugin.newShellTab = vi.fn();
    plugin.promptNewConversation = vi.fn();
    plugin.getConversations = () => [];
    plugin.wantsSkillOffer = vi.fn(() => false);
    view.tabBarEl = createMockEl();
    view.renderTabs();
    const plusBtn = view.tabBarEl.querySelector('.herdr-tab-actions .herdr-action-btn') as HTMLElement;
    expect(plusBtn).toBeTruthy();
    plusBtn.click();
    expect(plugin.newShellTab).toHaveBeenCalledTimes(1);
    expect(plugin.promptNewConversation).not.toHaveBeenCalled();
  });

  it('does not make tab draggable when only one tab exists', () => {
    plugin.getConversations = () => [{ tab_id: 't1', label: 'shell', status: 'idle' }];
    plugin.wantsSkillOffer = vi.fn(() => false);
    view.tabBarEl = createMockEl();
    view.renderTabs();
    const tabEl = view.tabBarEl.querySelector('.herdr-tab-item');
    expect(tabEl).toBeTruthy();
    expect(tabEl.getAttribute('draggable')).toBeNull();
  });

  it('makes tabs draggable and sets up reordering when multiple tabs exist', () => {
    plugin.getConversations = () => [
      { tab_id: 't1', label: 'shell', status: 'idle' },
      { tab_id: 't2', label: 'agent', status: 'working' }
    ];
    plugin.wantsSkillOffer = vi.fn(() => false);
    view.tabBarEl = createMockEl();
    view.renderTabs();
    const tabs = view.tabBarEl.querySelectorAll('.herdr-tab-item');
    expect(tabs.length).toBe(2);
    expect(tabs[0].getAttribute('draggable')).toBe('true');
    expect(tabs[1].getAttribute('draggable')).toBe('true');
  });

  it('does not apply drop target indicators when dragging over itself', () => {
    plugin.getConversations = () => [
      { tab_id: 't1', label: 'shell', status: 'idle' },
      { tab_id: 't2', label: 'agent', status: 'working' }
    ];
    plugin.wantsSkillOffer = vi.fn(() => false);
    view.tabBarEl = createMockEl();
    view.renderTabs();
    const tabEl = view.tabBarEl.querySelector('.herdr-tab-item') as HTMLElement;
    tabEl.classList.add('is-dragging');

    const dragOverEvt = new Event('dragover', { cancelable: true });
    tabEl.dispatchEvent(dragOverEvt);

    expect(tabEl.classList.contains('drop-target-left')).toBe(false);
    expect(tabEl.classList.contains('drop-target-right')).toBe(false);
  });
});

describe('getStatusBarOverlap', () => {
  let statusBar: HTMLElement;

  beforeEach(() => {
    view.terminalContainerEl = document.createElement('div');
    document.body.appendChild(view.terminalContainerEl);
    statusBar = document.createElement('div');
    statusBar.className = 'status-bar';
    document.body.appendChild(statusBar);
  });

  afterEach(() => {
    view.terminalContainerEl?.remove();
    statusBar?.remove();
  });

  it('returns 0 when status bar has zero dimensions', () => {
    expect(view.getStatusBarOverlap()).toBe(0);
  });

  it('calculates overlap when status bar sits at bottom-right of terminal', () => {
    vi.spyOn(statusBar, 'getBoundingClientRect').mockReturnValue({
      top: 770,
      bottom: 800,
      left: 800,
      right: 1200,
      width: 400,
      height: 30
    } as any);
    vi.spyOn(view.terminalContainerEl, 'getBoundingClientRect').mockReturnValue({
      top: 40,
      bottom: 800,
      left: 800,
      right: 1200,
      width: 400,
      height: 760
    } as any);

    expect(view.getStatusBarOverlap()).toBe(30);
  });

  it('returns 0 when terminal is horizontally non-overlapping (e.g. left side)', () => {
    vi.spyOn(statusBar, 'getBoundingClientRect').mockReturnValue({
      top: 770,
      bottom: 800,
      left: 800,
      right: 1200,
      width: 400,
      height: 30
    } as any);
    vi.spyOn(view.terminalContainerEl, 'getBoundingClientRect').mockReturnValue({
      top: 40,
      bottom: 800,
      left: 0,
      right: 300,
      width: 300,
      height: 760
    } as any);

    expect(view.getStatusBarOverlap()).toBe(0);
  });
});

describe('handleResize with status bar and padding', () => {
  it('applies paddingBottom and calculates cols and rows accounting for padding', () => {
    const container = document.createElement('div');
    container.style.paddingLeft = '8px';
    container.style.paddingRight = '8px';
    document.body.appendChild(container);

    Object.defineProperty(container, 'clientWidth', { value: 416, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 800, configurable: true });

    view.terminalContainerEl = container;
    view.getStatusBarOverlap = vi.fn(() => 30);

    const resizeMock = vi.fn();
    const clearMock = vi.fn();
    view.terminal = {
      cols: 0,
      rows: 0,
      resize: resizeMock,
      _core: {
        _renderService: {
          dimensions: {
            css: { cell: { width: 8, height: 16 } }
          },
          clear: clearMock
        }
      }
    };

    view.handleResize();

    // overlap (30) + 2 buffer = 32px paddingBottom
    expect(container.style.paddingBottom).toBe('32px');
    // available width: 416 - (8 + 8) = 400 => 400 / 8 = 50 cols
    // available height: 800 - 32 = 768 => 768 / 16 = 48 rows
    expect(resizeMock).toHaveBeenCalledWith(50, 48);
    // Symmetrical padding: 416 - (50 * 8) = 16px slack => 8px left, 8px right
    expect(container.style.paddingLeft).toBe('8px');
    expect(container.style.paddingRight).toBe('8px');

    container.remove();
  });

  it('balances extra horizontal slack equally between left and right', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    // 422 total width: 422 - 16 = 406 available => 50 cols (400px), 22px remaining slack => 11px left, 11px right
    Object.defineProperty(container, 'clientWidth', { value: 422, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 800, configurable: true });

    view.terminalContainerEl = container;
    view.getStatusBarOverlap = vi.fn(() => 0);

    const resizeMock = vi.fn();
    view.terminal = {
      cols: 0,
      rows: 0,
      resize: resizeMock,
      _core: {
        _renderService: {
          dimensions: {
            css: { cell: { width: 8, height: 16 } }
          },
          clear: vi.fn()
        }
      }
    };

    view.handleResize();

    expect(resizeMock).toHaveBeenCalledWith(50, 50);
    expect(container.style.paddingLeft).toBe('11px');
    expect(container.style.paddingRight).toBe('11px');

    container.remove();
  });

  it('clears paddingBottom when status bar does not overlap', () => {
    const container = document.createElement('div');
    container.style.paddingBottom = '32px';
    document.body.appendChild(container);

    Object.defineProperty(container, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 800, configurable: true });

    view.terminalContainerEl = container;
    view.terminal = { cols: 80, rows: 24, resize: vi.fn() };
    view.getStatusBarOverlap = vi.fn(() => 0);

    view.handleResize();

    expect(container.style.paddingBottom).toBe('');
    container.remove();
  });
});

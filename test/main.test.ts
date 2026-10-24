// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Platform, requestUrl, notices, FileSystemAdapter } from 'obsidian';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import HerdrPlugin from '../src/main';
import { AgentResolver } from '../src/resolver';
import { TerminalStream } from '../src/terminalStream';

const conv = (n: number, status = 'idle') => ({
  tab_id: `w1:t${n}`, workspace_id: 'w1', pane_id: `w1:p${n}`, agent: null, status, label: `tab${n}`, running: true
}) as any;

let plugin: any; // private members are exercised directly
let client: any;
let leaves: any[];

beforeEach(async () => {
  notices.length = 0;
  Platform.isMobile = false;
  leaves = [];
  const app = {
    vault: { adapter: {}, getName: () => 'vault', getFiles: () => [], getFileByPath: () => null },
    workspace: {
      onLayoutReady: (cb: () => void) => cb(),
      getLeavesOfType: () => leaves,
      getRightLeaf: () => ({ setViewState: vi.fn() }),
      revealLeaf: vi.fn()
    }
  };
  plugin = new HerdrPlugin(app as any, {} as any);
  await plugin.loadSettings();
  client = {
    isConfigured: () => true,
    snapshot: vi.fn(),
    createTab: vi.fn(),
    closeTab: vi.fn(),
    focusTab: vi.fn(async () => {}),
    createWorkspace: vi.fn()
  };
  plugin.client = client;
  plugin.resolver = new AgentResolver(client);
  plugin.saveSettings = vi.fn();
});
afterEach(() => vi.mocked(requestUrl).mockReset());

describe('settings and client selection', () => {
  it('loads defaults merged with saved data', async () => {
    plugin.loadData = async () => ({ fontSize: 18 });
    await plugin.loadSettings();
    expect(plugin.settings).toMatchObject({ fontSize: 18, themeMode: 'auto', autoSyncOnOpen: true, bridgeHost: '' });
  });

  it('defaults to the bridge on this machine, and tells local bridges from remote ones', () => {
    expect(plugin.bridgeHost()).toBe('127.0.0.1:7788');
    expect(plugin.createTerminalStream('p', {})).toBeInstanceOf(TerminalStream);
    for (const host of ['', 'localhost:7788', '127.0.0.1:9000', 'http://[::1]:7788']) {
      plugin.settings.bridgeHost = host;
      expect(plugin.isRemoteBridge()).toBe(false);
    }
    for (const host of ['100.85.12.34:7788', 'laptop.tailnet.ts.net', 'https://bridge.example']) {
      plugin.settings.bridgeHost = host;
      expect(plugin.isRemoteBridge()).toBe(true);
    }
  });
});

describe('tab ordering', () => {
  beforeEach(() => {
    plugin.convByTab = new Map([1, 2, 3].map((n) => [`w1:t${n}`, conv(n)]));
  });
  const ids = () => plugin.getConversations().map((c: any) => c.tab_id);

  it('applies the saved tab order, unknown tabs last', () => {
    plugin.settings.tabOrder = ['w1:t3', 'w1:t1'];
    expect(ids()).toEqual(['w1:t3', 'w1:t1', 'w1:t2']);
  });

  it('reorders before or after a target and persists the order', async () => {
    await plugin.reorderTab('w1:t3', 'w1:t1', true);
    expect(ids()).toEqual(['w1:t3', 'w1:t1', 'w1:t2']);
    await plugin.reorderTab('w1:t3', 'w1:t2', false);
    expect(ids()).toEqual(['w1:t1', 'w1:t2', 'w1:t3']);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(2);
  });

  it('no-ops when reordering a tab onto itself', async () => {
    await plugin.reorderTab('w1:t1', 'w1:t1', true);
    expect(ids()).toEqual(['w1:t1', 'w1:t2', 'w1:t3']);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('next/prev cycle through tabs', async () => {
    plugin.activateConversation = vi.fn();
    plugin.currentActiveTabId = 'w1:t3';
    plugin.switchNext();
    expect(plugin.activateConversation).toHaveBeenLastCalledWith(conv(1));
    plugin.currentActiveTabId = 'w1:t1';
    plugin.switchPrev();
    expect(plugin.activateConversation).toHaveBeenLastCalledWith(conv(3));
  });
});

describe('refreshState', () => {
  it('builds conversations for the vault workspace and follows external focus', async () => {
    client.snapshot.mockResolvedValue({
      workspaces: [{ workspace_id: 'w1', label: 'vault' }],
      tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'a' }, { tab_id: 'w1:t2', workspace_id: 'w1', label: 'b' }],
      panes: [],
      focused_tab_id: 'w1:t2'
    });
    await plugin.refreshState();
    expect(plugin.getConversations().map((c: any) => c.label)).toEqual(['a', 'b']);
    expect(plugin.singletonWorkspaceId).toBe('w1');
    expect(plugin.currentActiveTabId).toBe('w1:t2');
  });

  it('keeps the old conversations when the snapshot fails', async () => {
    plugin.convByTab = new Map([['w1:t1', conv(1)]]);
    client.snapshot.mockRejectedValue(new Error('down'));
    await plugin.refreshState();
    expect(plugin.getConversations()).toHaveLength(1);
  });
});

describe('closeConversationTab', () => {
  beforeEach(() => {
    plugin.refreshState = vi.fn();
  });

  it('opens a shell first when closing the last tab, so the workspace survives', async () => {
    client.snapshot.mockResolvedValue({ tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1' }] });
    await plugin.closeConversationTab(conv(1));
    expect(client.createTab).toHaveBeenCalledWith('w1', 'shell', false);
    expect(client.closeTab).toHaveBeenCalledWith('w1:t1');
  });

  it('just closes when other tabs remain', async () => {
    client.snapshot.mockResolvedValue({ tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1' }, { tab_id: 'w1:t2', workspace_id: 'w1' }] });
    await plugin.closeConversationTab(conv(1));
    expect(client.createTab).not.toHaveBeenCalled();
  });

  it('reports failures', async () => {
    client.snapshot.mockRejectedValue(new Error('down'));
    await plugin.closeConversationTab(conv(1));
    expect(notices).toEqual(['Failed to close tab: down']);
  });
});

describe('syncVault', () => {
  it('never syncs with a bridge on this machine: the agents already work in this folder', async () => {
    plugin.settings.bridgeToken = 't';
    await plugin.syncVault(true);
    plugin.settings.bridgeHost = 'localhost:7788';
    await plugin.syncVault(true);
    expect(notices).toEqual([]);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it('requires the token (quietly unless manual)', async () => {
    plugin.settings.bridgeHost = 'laptop';
    await plugin.syncVault(false);
    await plugin.syncVault(true);
    expect(notices).toEqual(['Set the herdr-bridge token in the plugin settings to sync.']);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it('runs a sync, without needing a workspace, and persists the ledger', async () => {
    plugin.settings.bridgeHost = 'laptop';
    plugin.settings.bridgeToken = 't';
    plugin.app.vault.createBinary = vi.fn(async () => {});
    plugin.app.vault.getFolderByPath = () => null;
    plugin.app.vault.adapter.stat = async () => ({ mtime: 5000 });
    vi.mocked(requestUrl).mockImplementation((async ({ url }: any) =>
      url.includes('manifest') ? { status: 200, json: [{ path: 'a.png', mtime: 4, size: 1 }] } : { status: 200, arrayBuffer: new ArrayBuffer(1) }) as any);
    await plugin.syncVault(true);
    expect(plugin.settings.syncLedger).toEqual({ 'a.png': { localMtime: 5000, remoteMtime: 4 } });
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(notices.at(-1)).toBe('Vault synced: 1 pulled, 0 pushed');
  });

  it('runs one sync at a time: calls made meanwhile share one follow-up, a whole-vault one covering pushed files', async () => {
    plugin.settings.bridgeHost = 'laptop';
    plugin.settings.bridgeToken = 't';
    const urls: string[] = [];
    vi.mocked(requestUrl).mockImplementation((async ({ url }: any) => {
      urls.push(new URL(url).pathname.split('/').pop()!);
      return { status: 200, json: [] };
    }) as any);
    // Two calls before the first starts share it.
    await Promise.all([plugin.syncVault(false), plugin.syncVault(true)]);
    expect(urls).toEqual(['manifest']);
    // Calls while one runs wait for it, then run once: a whole-vault sync, needing no file of its own.
    const running = plugin.syncVault(false);
    await Promise.resolve();
    const followUps = [plugin.syncVault(false, [{ path: 'a.md', deleted: true }]), plugin.syncVault(false)];
    await Promise.all([running, ...followUps]);
    expect(urls).toEqual(['manifest', 'manifest', 'manifest']);
  });
});

describe('live vault sync', () => {
  let push: (evt: any) => void;
  let syncs: any[][];

  beforeEach(() => {
    vi.useFakeTimers();
    plugin.settings.bridgeHost = 'laptop';
    plugin.settings.bridgeToken = 't';
    client.subscribeEvents = vi.fn(async (cb: any) => {
      push = cb;
      return vi.fn();
    });
    syncs = [];
    plugin.runSync = vi.fn(async (...args: any[]) => {
      syncs.push(args);
    });
    plugin.subscribeEvents();
  });
  afterEach(() => vi.useRealTimers());

  it('syncs the whole vault on each (re)connect, and just the files the bridge pushes for this vault', async () => {
    push({ type: 'connected' });
    const files = [{ path: 'a.md', mtime: 1, mtime_ms: 1000, size: 1 }];
    await vi.runAllTimersAsync();
    push({ type: 'vault_changed', vault: 'vault', files });
    push({ type: 'vault_changed', vault: 'Other', files });
    await vi.runAllTimersAsync();
    expect(syncs).toEqual([[false, undefined], [false, files]]);
  });

  it('does nothing automatically with automatic sync off', async () => {
    plugin.settings.autoSyncOnOpen = false;
    push({ type: 'connected' });
    push({ type: 'vault_changed', vault: 'vault', files: [] });
    plugin.localEdited('a.md');
    await vi.runAllTimersAsync();
    expect(syncs).toEqual([]);
  });

  it('pushes phone edits once they settle, ignoring the writes of a sync itself', async () => {
    const files: Record<string, any> = { 'pulled.md': { stat: { mtime: 5 } }, 'typed.md': { stat: { mtime: 9 } } };
    plugin.app.vault.getFileByPath = (p: string) => files[p] ?? null;
    plugin.settings.syncLedger = { 'pulled.md': { localMtime: 5, remoteMtime: 1 }, 'typed.md': { localMtime: 7, remoteMtime: 1 } };

    plugin.localEdited('pulled.md');
    plugin.localEdited('.obsidian/workspace.json');
    await vi.advanceTimersByTimeAsync(3000);
    expect(syncs).toEqual([]);

    plugin.localEdited('typed.md');
    await vi.advanceTimersByTimeAsync(2000);
    plugin.localEdited('typed.md'); // still typing: the wait starts over
    await vi.advanceTimersByTimeAsync(2000);
    expect(syncs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(syncs).toEqual([[false, undefined]]);
  });

  it('pushes a phone deletion of a synced file', async () => {
    plugin.settings.syncLedger = { 'gone.md': { localMtime: 5, remoteMtime: 1 } };
    plugin.localEdited('gone.md');
    await vi.advanceTimersByTimeAsync(3000);
    expect(syncs).toEqual([[false, undefined]]);
  });
});

describe('live updates', () => {
  const snapshot = {
    workspaces: [{ workspace_id: 'w1', label: 'vault' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'a' }],
    panes: []
  };
  let push: (evt: any) => void;
  let unsub: any;

  beforeEach(() => {
    unsub = vi.fn();
    client.subscribeEvents = vi.fn(async (cb: any) => {
      push = cb;
      return unsub;
    });
  });

  it("applies the bridge's pushed snapshots without fetching any", async () => {
    plugin.subscribeEvents();
    // As the bridge sends it: herdr's reply, which wraps the snapshot.
    await push({ type: 'snapshot', data: { type: 'session_snapshot', snapshot } });
    expect(plugin.getConversations().map((c: any) => c.label)).toEqual(['a']);
    expect(client.snapshot).not.toHaveBeenCalled();
  });

  it('shows offline when the bridge reports an error', async () => {
    plugin.updateStatusBar = vi.fn();
    plugin.subscribeEvents();
    push({ type: 'error', error: 'Bridge unreachable' });
    expect(plugin.updateStatusBar).toHaveBeenCalledWith([], false);
  });

  it('drops a subscription that resolves after a disconnect', async () => {
    plugin.subscribeEvents();
    plugin.disconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(unsub).toHaveBeenCalled();
    expect(plugin.unsubscribeEvents).toBeNull();
  });

  it('disconnect stops the live updates', async () => {
    plugin.subscribeEvents();
    await Promise.resolve();
    await Promise.resolve();
    plugin.disconnect();
    expect(unsub).toHaveBeenCalled();
  });

  it('only re-renders the tab bar when the conversations changed', async () => {
    const view = { renderTabs: vi.fn() };
    plugin.getTerminalView = () => view;
    await plugin.applySnapshot(snapshot);
    await plugin.applySnapshot(snapshot);
    expect(view.renderTabs).toHaveBeenCalledTimes(1);
    await plugin.applySnapshot({ ...snapshot, tabs: [...snapshot.tabs, { tab_id: 'w1:t2', workspace_id: 'w1' }] });
    expect(view.renderTabs).toHaveBeenCalledTimes(2);
  });
});

describe('refresh coalescing', () => {
  it('runs one snapshot request at a time, and calls made meanwhile share one follow-up', async () => {
    let release!: () => void;
    client.snapshot.mockImplementation(() => new Promise((r) => (release = () => r({ workspaces: [], tabs: [], panes: [] }))));
    const first = plugin.refreshState();
    await Promise.resolve();
    await Promise.resolve();
    const second = plugin.refreshState();
    const third = plugin.refreshState();
    expect(second).toBe(third);
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    release();
    await first;
    await vi.waitFor(() => expect(client.snapshot).toHaveBeenCalledTimes(2));
    release();
    await second;
    expect(client.snapshot).toHaveBeenCalledTimes(2);
  });
});

describe('vault workspace', () => {
  beforeEach(() => {
    plugin.settings.bridgeHost = '100.85.12.34:7788';
  });

  it('a phone (no real vault folder) never creates a workspace on the laptop', async () => {
    client.snapshot.mockResolvedValue({ workspaces: [{ workspace_id: 'w1', label: 'other' }], tabs: [], panes: [] });
    await plugin.refreshState();
    expect(client.createWorkspace).not.toHaveBeenCalled();
    expect(plugin.singletonWorkspaceId).toBeUndefined();
    await plugin.newShellTab();
    expect(client.createTab).not.toHaveBeenCalled();
    expect(notices.at(-1)).toMatch(/open the vault in Obsidian on the machine running herdr-bridge first/);
  });

  it('a phone attaches to the workspace named like its vault', async () => {
    client.snapshot.mockResolvedValue({ workspaces: [{ workspace_id: 'w1', label: 'vault' }], tabs: [], panes: [] });
    await plugin.refreshState();
    expect(plugin.singletonWorkspaceId).toBe('w1');
  });

  it('a desktop pointed at another machine attaches only: its vault path means nothing there', async () => {
    plugin.app.vault.adapter = new FileSystemAdapter('/home/u/notes');
    client.snapshot.mockResolvedValue({ workspaces: [], tabs: [], panes: [] });
    await plugin.refreshState();
    expect(client.createWorkspace).not.toHaveBeenCalled();
  });

  it('a desktop vault folder gets its workspace created by the bridge on this machine', async () => {
    plugin.settings.bridgeHost = '';
    plugin.app.vault.adapter = new FileSystemAdapter('/home/u/notes');
    client.snapshot.mockResolvedValue({ workspaces: [], tabs: [], panes: [] });
    client.createWorkspace.mockResolvedValue({ workspace: { workspace_id: 'w9', label: 'notes' } });
    await plugin.refreshState();
    expect(client.createWorkspace).toHaveBeenCalledWith('/home/u/notes', 'notes', false);
    expect(plugin.singletonWorkspaceId).toBe('w9');
  });
});

describe('agent open requests', () => {
  beforeEach(() => {
    plugin.app.vault.getFileByPath = (p: string) => (p === 'a/Note.md' ? { path: p } : null);
    plugin.app.workspace.openLinkText = vi.fn(async () => {});
  });

  it('opens an existing note at a heading and line', async () => {
    await plugin.openForAgent('a/Note.md', 'Intro', 7);
    expect(plugin.app.workspace.openLinkText).toHaveBeenCalledWith('a/Note.md#Intro', '', false, { eState: { line: 7 } });
  });

  it('refuses missing files, parent paths and a disabled setting', async () => {
    await plugin.openForAgent('nope.md');
    await plugin.openForAgent('../a/Note.md');
    plugin.settings.allowAgentOpen = false;
    await plugin.openForAgent('a/Note.md');
    expect(plugin.app.workspace.openLinkText).not.toHaveBeenCalled();
    expect(notices).toHaveLength(2);
  });

  it('offers the skill once, and a no writes nothing', async () => {
    plugin.installAgentSkill = vi.fn();
    expect(plugin.wantsSkillOffer()).toBe(true);
    await plugin.answerSkillOffer(false);
    expect(plugin.wantsSkillOffer()).toBe(false);
    expect(plugin.installAgentSkill).not.toHaveBeenCalled();
  });

  it('installs the skill in .agents, linked from .claude over an older copy', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    mkdirSync(join(vault, '.claude/skills/herdr-open'), { recursive: true });
    plugin.app.vault.adapter = Object.assign(new FileSystemAdapter(vault), {
      mkdir: async (p: string) => void mkdirSync(join(vault, p), { recursive: true }),
      write: async (p: string, data: string) => writeFileSync(join(vault, p), data)
    });
    await plugin.installAgentSkill();
    expect(readlinkSync(join(vault, '.claude/skills/herdr-open'))).toBe('../../.agents/skills/herdr-open');
    expect(readFileSync(join(vault, '.claude/skills/herdr-open/SKILL.md'), 'utf8')).toContain('name: herdr-open');
  });
});

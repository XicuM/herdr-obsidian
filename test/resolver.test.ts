import { describe, it, expect, vi } from 'vitest';
import { AgentResolver, compareConversationsByStatus, Conversation } from '../src/resolver';
import { Snapshot } from '../src/herdrClient';

const snap = (s: Partial<Snapshot>): Snapshot => ({ agents: [], panes: [], tabs: [], workspaces: [], ...s });

describe('findWorkspaceForFolder', () => {
  const resolver = new AgentResolver({ createWorkspace: vi.fn() });

  it('prefers a label match that also has a pane in the folder', () => {
    const s = snap({
      workspaces: [
        { workspace_id: 'w1', label: 'vault' },
        { workspace_id: 'w2', label: 'vault' }
      ],
      panes: [{ workspace_id: 'w2', cwd: '/home/u/vault' }]
    });
    expect(resolver.findWorkspaceForFolder(s, '/home/u/vault')?.workspace_id).toBe('w2');
  });

  it('matches by pane cwd when the label differs', () => {
    const s = snap({
      workspaces: [{ workspace_id: 'w1', label: 'other' }],
      panes: [{ workspace_id: 'w1', foreground_cwd: '/home/u/vault/' }]
    });
    expect(resolver.findWorkspaceForFolder(s, '/home/u/vault')?.workspace_id).toBe('w1');
  });

  it('normalises Windows separators and trailing slashes', () => {
    const s = snap({
      workspaces: [{ workspace_id: 'w1', label: 'x' }],
      panes: [{ workspace_id: 'w1', cwd: 'C:\\Users\\u\\vault\\' }]
    });
    expect(resolver.findWorkspaceForFolder(s, 'C:/Users/u/vault')?.workspace_id).toBe('w1');
  });

  it('falls back to a bare label match', () => {
    const s = snap({ workspaces: [{ workspace_id: 'w1', label: 'vault' }] });
    expect(resolver.findWorkspaceForFolder(s, '/elsewhere/vault')?.workspace_id).toBe('w1');
  });

  it('returns null when nothing matches, tolerating missing arrays', () => {
    expect(resolver.findWorkspaceForFolder({} as Snapshot, '/home/u/vault')).toBeNull();
  });
});

describe('ensureWorkspace', () => {
  it('returns the existing workspace without creating one', async () => {
    const createWorkspace = vi.fn();
    const r = new AgentResolver({ createWorkspace });
    const id = await r.ensureWorkspace('/v/notes', snap({ workspaces: [{ workspace_id: 'w1', label: 'notes' }] }));
    expect(id).toBe('w1');
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('creates a workspace labelled after the folder basename', async () => {
    const createWorkspace = vi.fn().mockResolvedValue({ workspace: { workspace_id: 'new', label: 'notes' } });
    const r = new AgentResolver({ createWorkspace });
    expect(await r.ensureWorkspace('/v/notes/', snap({}))).toBe('new');
    expect(createWorkspace).toHaveBeenCalledWith('/v/notes', 'notes', false);
  });
});

describe('buildConversations', () => {
  const resolver = new AgentResolver({ createWorkspace: vi.fn() });

  it('builds one conversation per tab in the vault workspace, sorted by tab id', () => {
    const s = snap({
      workspaces: [{ workspace_id: 'w1', label: 'vault' }, { workspace_id: 'w9', label: 'zzz' }],
      tabs: [
        { tab_id: 'w1:t2', workspace_id: 'w1', label: 'notes', agent_status: 'idle', pane_count: 0 },
        { tab_id: 'w1:t1', workspace_id: 'w1', label: 'shell', pane_count: 1 },
        { tab_id: 'w9:t1', workspace_id: 'w9' }
      ],
      panes: [{ workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', cwd: '/v/vault', agent: 'claude', agent_status: 'blocked' }]
    });
    expect(resolver.buildConversations(s, '/v/vault')).toEqual([
      { tab_id: 'w1:t1', workspace_id: 'w1', pane_id: 'w1:p1', agent: 'claude', status: 'blocked', label: 'claude', running: true },
      // No pane: pane id is derived from the tab id, status falls back to the tab's.
      { tab_id: 'w1:t2', workspace_id: 'w1', pane_id: 'w1:p2', agent: null, status: 'idle', label: 'notes', running: false }
    ]);
  });

  it('returns [] when there is no vault workspace', () => {
    expect(resolver.buildConversations(snap({}), '/v/vault')).toEqual([]);
  });
});

describe('compareConversationsByStatus', () => {
  it('orders blocked > working > done > idle > unknown, then by label', () => {
    const c = (status: any, label: string) => ({ status, label }) as Conversation;
    const sorted = [c('idle', 'a'), c('unknown', 'a'), c('working', 'b'), c('blocked', 'z'), c('working', 'a'), c('done', 'a')]
      .sort(compareConversationsByStatus)
      .map((x) => `${x.status}:${x.label}`);
    expect(sorted).toEqual(['blocked:z', 'working:a', 'working:b', 'done:a', 'idle:a', 'unknown:a']);
  });
});

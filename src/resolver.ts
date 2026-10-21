import { Snapshot, AgentStatus, Workspace } from './herdrClient';

export interface IWorkspaceCreator {
  createWorkspace(cwd: string, label: string, focus?: boolean): Promise<{ workspace: Workspace }>;
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function getBaseName(p: string): string {
  const n = normPath(p);
  const parts = n.split('/');
  return parts.pop() || n;
}

export interface Conversation {
  tab_id: string;
  workspace_id: string;
  pane_id: string;
  agent: string | null;
  status: AgentStatus;
  label: string;
  running: boolean;
}

export const STATUS_PRIORITY: Record<string, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4
};

export function compareConversationsByStatus(a: Conversation, b: Conversation): number {
  const prioDiff = (STATUS_PRIORITY[a.status] ?? 5) - (STATUS_PRIORITY[b.status] ?? 5);
  if (prioDiff !== 0) return prioDiff;
  return a.label.localeCompare(b.label);
}

export class AgentResolver {
  constructor(private client: IWorkspaceCreator) {}

  /**
   * Find the singleton workspace for a vault folder.
   * Matches by folder path on pane cwd or matching label.
   */
  findWorkspaceForFolder(snapshot: Snapshot, folderPath: string): Workspace | null {
    const norm = normPath(folderPath);
    const folderBase = getBaseName(norm);

    // 1. Check workspace with matching label and at least one pane in this folder
    const matchingByLabel = (snapshot.workspaces || []).filter((w) => w.label === folderBase);
    for (const w of matchingByLabel) {
      const hasPaneInFolder = (snapshot.panes || []).some(
        (p) => p.workspace_id === w.workspace_id && normPath(p.cwd || p.foreground_cwd || '') === norm
      );
      if (hasPaneInFolder) return w;
    }

    // 2. Check any workspace where any pane has cwd matching folder path
    for (const w of (snapshot.workspaces || [])) {
      const hasPaneInFolder = (snapshot.panes || []).some(
        (p) => p.workspace_id === w.workspace_id && normPath(p.cwd || p.foreground_cwd || '') === norm
      );
      if (hasPaneInFolder) return w;
    }

    // 3. Fall back to label match
    if (matchingByLabel.length > 0) return matchingByLabel[0];

    return null;
  }

  /**
   * Ensure a singleton workspace exists for this vault; create it if missing.
   */
  async ensureWorkspace(folderPath: string, snapshot: Snapshot): Promise<string> {
    const existing = this.findWorkspaceForFolder(snapshot, folderPath);
    if (existing) return existing.workspace_id;
    const label = getBaseName(folderPath);
    const created = await this.client.createWorkspace(normPath(folderPath), label, false);
    return created.workspace.workspace_id;
  }

  buildConversations(snapshot: Snapshot, folderPath: string): Conversation[] {
    const ws = this.findWorkspaceForFolder(snapshot, folderPath);
    if (!ws) return [];
    const panes = (snapshot.panes || []).filter((p) => p.workspace_id === ws.workspace_id);
    return (snapshot.tabs || [])
      .filter((t) => t.workspace_id === ws.workspace_id)
      .map((t) => {
        const pane = panes.find((p) => p.tab_id === t.tab_id) || null;
        const agent = (pane?.agent as string) || null;
        const status = (pane?.agent_status || t.agent_status || 'unknown') as AgentStatus;
        return {
          tab_id: t.tab_id,
          workspace_id: ws.workspace_id,
          pane_id: pane?.pane_id || t.tab_id.replace(/:t([^:]*)$/, ':p$1'),
          agent,
          status,
          label: agent || t.label || 'shell',
          running: !!agent || (t.pane_count ?? 0) > 0
        } as Conversation;
      })
      .sort((a, b) => (a.tab_id < b.tab_id ? -1 : a.tab_id > b.tab_id ? 1 : 0));
  }
}

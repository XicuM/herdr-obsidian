import { requestUrl } from 'obsidian';
import { Snapshot, Workspace, Tab, Agent, HarnessKind } from './herdrClient';

export interface RemoteBridgeOptions {
  host: string;
  token: string;
  session?: string;
}

export class RemoteBridgeClient {
  private httpBase: string;
  private wsBase: string;
  private token: string;
  public readonly session: string;

  constructor(opts: RemoteBridgeOptions) {
    let raw = opts.host.trim().replace(/\/+$/, '');
    if (!raw.includes('://')) {
      raw = `http://${raw}`;
    }
    try {
      const u = new URL(raw);
      this.httpBase = `${u.protocol}//${u.host}`;
      this.wsBase = `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
    } catch {
      this.httpBase = `http://${opts.host}`;
      this.wsBase = `ws://${opts.host}`;
    }
    this.token = opts.token.trim();
    this.session = opts.session || 'herdr-obsidian';
  }

  getHost(): string {
    return this.httpBase;
  }

  isConfigured(): boolean {
    return !!this.httpBase && !!this.token;
  }

  isAvailable(): boolean {
    return this.isConfigured();
  }

  async checkHealth(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const res = await requestUrl({
        url: `${this.httpBase}/health`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  private async rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const url = `${this.httpBase}/s/${encodeURIComponent(this.session)}/api/rpc/${encodeURIComponent(method)}`;
    const res = await requestUrl({
      url,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(params)
    });
    if (res.status >= 400) {
      throw new Error(`Herdr RPC ${method} failed (${res.status}): ${res.text}`);
    }
    return res.json;
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.rpc('ping', {});
      return r?.type === 'pong' || !!r;
    } catch {
      return false;
    }
  }

  async snapshot(): Promise<Snapshot> {
    const url = `${this.httpBase}/s/${encodeURIComponent(this.session)}/api/snapshot`;
    const res = await requestUrl({
      url,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });
    if (res.status >= 400) {
      throw new Error(`Failed to fetch snapshot (${res.status}): ${res.text}`);
    }
    const data = res.json;
    return (data.snapshot || data) as Snapshot;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const r = await this.rpc('workspace.list', {});
    return r.workspaces || [];
  }

  async createWorkspace(cwd: string, label: string, focus = false): Promise<{ workspace: Workspace }> {
    return await this.rpc('workspace.create', { cwd, label, focus });
  }

  async listTabs(workspaceId: string): Promise<Tab[]> {
    const r = await this.rpc('tab.list', { workspace_id: workspaceId });
    return r.tabs || [];
  }

  async listPanes(workspaceId?: string): Promise<any[]> {
    const r = await this.rpc('pane.list', { workspace_id: workspaceId || null });
    return r.panes || [];
  }

  async createTab(
    workspaceId: string,
    label?: string | null,
    focus = false,
    env?: Record<string, string>
  ): Promise<{ tab: Tab; root_pane: any }> {
    const res = await this.rpc('tab.create', {
      workspace_id: workspaceId,
      label,
      focus,
      ...(env ? { env } : {})
    });
    return {
      tab: res.tab || res,
      root_pane: res.root_pane || res.pane || { pane_id: res.pane_id }
    };
  }

  async focusTab(tabId: string): Promise<void> {
    await this.rpc('tab.focus', { tab_id: tabId });
  }

  async focusWorkspace(workspaceId: string): Promise<void> {
    await this.rpc('workspace.focus', { workspace_id: workspaceId });
  }

  async listAgents(): Promise<Agent[]> {
    const r = await this.rpc('agent.list', {});
    return r.agents || [];
  }

  async getAgent(target: string): Promise<any> {
    return await this.rpc('agent.get', { target });
  }

  async closeTab(tabId: string): Promise<void> {
    await this.rpc('tab.close', { tab_id: tabId });
  }

  async renameTab(tabId: string, label: string): Promise<any> {
    return await this.rpc('tab.rename', { tab_id: tabId, label });
  }

  async focusPane(paneId: string): Promise<any> {
    return await this.rpc('pane.focus', { pane_id: paneId });
  }

  async agentStart(
    name: string,
    kind: string,
    paneId: string,
    args: string[] = [],
    timeoutMs = 60000
  ): Promise<any> {
    return await this.rpc('agent.start', {
      name,
      kind,
      pane_id: paneId,
      timeout_ms: timeoutMs,
      ...(args.length ? { args } : {})
    });
  }

  async subscribeEvents(cb: (evt: any) => void): Promise<() => void> {
    const wsUrl = `${this.wsBase}/s/${encodeURIComponent(this.session)}/ws/session?token=${encodeURIComponent(this.token)}`;
    let ws: WebSocket | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl);
        ws.onmessage = (event) => {
          if (closed) return;
          try {
            const data = JSON.parse(event.data);
            cb(data);
          } catch {}
        };
        ws.onerror = () => {};
        ws.onclose = () => {
          if (!closed) {
            setTimeout(connect, 3000);
          }
        };
      } catch {}
    };

    connect();

    return () => {
      closed = true;
      if (ws) {
        ws.close();
        ws = null;
      }
    };
  }
}

import { requestUrl } from 'obsidian';
import type { RemoteChange } from './vaultSync';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export const HARNESS_KINDS = [
  'agy',
  'amp',
  'claude',
  'codex',
  'copilot',
  'cursor',
  'devin',
  'gemini',
  'grok',
  'kimi',
  'kiro',
  'maki',
  'opencode',
  'pi',
  'qwen'
] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

export interface Agent {
  agent: string;
  agent_status: AgentStatus;
  cwd?: string;
  pane_id: string;
  tab_id?: string;
  workspace_id?: string;
  terminal_id?: string;
  state_change_seq?: number;
  agent_session?: { kind: string; value: string; source: string };
}

export interface Workspace {
  workspace_id: string;
  label: string;
  active_tab_id?: string;
  agent_status?: AgentStatus;
  pane_count?: number;
  tab_count?: number;
}

export interface Tab {
  tab_id: string;
  workspace_id: string;
  label?: string;
  agent_status?: AgentStatus;
  pane_count?: number;
}

export interface Pane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  cwd?: string;
  foreground_cwd?: string;
  agent?: string;
  agent_status?: AgentStatus;
}

export interface Snapshot {
  agents: Agent[];
  panes: Pane[];
  tabs: Tab[];
  workspaces: Workspace[];
  focused_workspace_id?: string;
  focused_tab_id?: string;
  version?: string;
}

/** What herdr-bridge pushes on `/ws/session`: each new snapshot (wrapped in herdr's reply), why there is none, or an agent asking to show a note. */
export type BridgeEvent =
  /** Not from the bridge: the connection (re)opened, so pushes sent while it was down were missed. */
  | { type: 'connected' }
  | { type: 'vault_changed'; vault: string; files: RemoteChange[] }
  | { type: 'snapshot'; data: Snapshot & { snapshot?: Snapshot } }
  | { type: 'error'; error: string }
  | { type: 'open'; vault?: string; path: string; heading?: string; line?: number };

export interface HerdrClientOptions {
  host: string;
  token: string;
  session?: string;
}

/**
 * Herdr, reached through herdr-bridge over HTTP and WebSockets: on this machine (`127.0.0.1:7788`)
 * or another one (e.g. a laptop over Tailscale, from a phone). No Node APIs, so it runs on mobile too.
 */
export class HerdrClient {
  private httpBase: string;
  private wsBase: string;
  private token: string;
  public readonly session: string;

  constructor(opts: HerdrClientOptions) {
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

  private async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const url = `${this.httpBase}/s/${encodeURIComponent(this.session)}/api/rpc/${encodeURIComponent(method)}`;
    const res = await requestUrl({
      url,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(params),
      throw: false
    });
    if (res.status >= 400) {
      throw new Error(`Herdr RPC ${method} failed (${res.status}): ${res.text}`);
    }
    return res.json as unknown;
  }

  async snapshot(): Promise<Snapshot> {
    const url = `${this.httpBase}/s/${encodeURIComponent(this.session)}/api/snapshot`;
    const res = await requestUrl({
      url,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`
      },
      throw: false
    });
    if (res.status >= 400) {
      throw new Error(`Failed to fetch snapshot (${res.status}): ${res.text}`);
    }
    const data = res.json as Snapshot & { snapshot?: Snapshot };
    return data.snapshot || data;
  }

  async createWorkspace(cwd: string, label: string, focus = false): Promise<{ workspace: Workspace }> {
    return (await this.rpc('workspace.create', { cwd, label, focus })) as { workspace: Workspace };
  }

  async createTab(
    workspaceId: string,
    label?: string | null,
    focus = false,
    env?: Record<string, string>
  ): Promise<{ tab: Tab; root_pane: { pane_id: string } }> {
    const res = (await this.rpc('tab.create', {
      workspace_id: workspaceId,
      label,
      focus,
      ...(env ? { env } : {})
    })) as { tab?: Tab; root_pane?: { pane_id: string }; pane?: { pane_id: string }; pane_id?: string } & Tab;
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

  async closeTab(tabId: string): Promise<void> {
    await this.rpc('tab.close', { tab_id: tabId });
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    await this.rpc('tab.rename', { tab_id: tabId, label });
  }

  /** Retries for a while when the new pane's shell isn't ready yet ("is not an available shell"). */
  async agentStart(
    name: string,
    kind: string,
    paneId: string,
    args: string[] = [],
    timeoutMs = 60000
  ): Promise<unknown> {
    const start = Date.now();
    for (;;) {
      try {
        return await this.rpc('agent.start', {
          name,
          kind,
          pane_id: paneId,
          timeout_ms: timeoutMs,
          ...(args.length ? { args } : {})
        });
      } catch (err) {
        if (!String(err).includes('is not an available shell') || Date.now() - start > 15000) throw err;
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    }
  }

  async subscribeEvents(cb: (evt: BridgeEvent) => void): Promise<() => void> {
    const wsUrl = `${this.wsBase}/s/${encodeURIComponent(this.session)}/ws/session?token=${encodeURIComponent(this.token)}`;
    let ws: WebSocket | null = null;
    let closed = false;
    let retryTimer: number | null = null;
    // Doubles up to a minute while the bridge is unreachable, so an offline phone isn't woken every few seconds.
    let delay = 1000;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          delay = 1000;
          if (!closed) cb({ type: 'connected' });
        };
        ws.onmessage = (event) => {
          if (closed) return;
          try {
            cb(JSON.parse(event.data as string) as BridgeEvent);
          } catch {
            // Not JSON: nothing the bridge sends on purpose.
          }
        };
        ws.onclose = () => {
          if (!closed) {
            // Shown like the bridge's own errors: there is no live snapshot until it reconnects.
            cb({ type: 'error', error: 'Bridge unreachable' });
            retryTimer = window.setTimeout(connect, delay);
            delay = Math.min(delay * 2, 60000);
          }
        };
      } catch {
        // An invalid URL: the settings must change, which reconnects.
      }
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      if (ws) {
        ws.close();
        ws = null;
      }
    };
  }
}

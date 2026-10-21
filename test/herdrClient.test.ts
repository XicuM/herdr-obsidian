// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { HerdrClient } from '../src/herdrClient';
import { FakeWebSocket } from './fakeWebSocket';

const req = () => vi.mocked(requestUrl).mock.calls.at(-1)![0] as any;

beforeEach(() => {
  vi.mocked(requestUrl).mockReset();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('HerdrClient', () => {
  it('derives http and ws bases from a bare host', () => {
    const c = new HerdrClient({ host: ' laptop:7788/ ', token: ' t ' });
    expect(c.getHost()).toBe('http://laptop:7788');
    expect(c.session).toBe('herdr-obsidian');
    expect(c.isConfigured()).toBe(true);
  });

  it('is not configured without a token', () => {
    expect(new HerdrClient({ host: '127.0.0.1:7788', token: '' }).isConfigured()).toBe(false);
  });

  it('sends RPCs as JSON POSTs to the session endpoint', async () => {
    const c = new HerdrClient({ host: 'https://laptop', token: 't', session: 's 1' });
    vi.mocked(requestUrl).mockResolvedValueOnce({ status: 200, json: { workspace: { workspace_id: 'w1' } } } as any);
    expect(await c.createWorkspace('/v', 'v', true)).toEqual({ workspace: { workspace_id: 'w1' } });
    expect(req()).toMatchObject({
      url: 'https://laptop/s/s%201/api/rpc/workspace.create',
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }
    });
    expect(JSON.parse(req().body)).toEqual({ cwd: '/v', label: 'v', focus: true });
  });

  it('throws on RPC HTTP errors with the bridge\'s message', async () => {
    const c = new HerdrClient({ host: 'laptop', token: 't' });
    vi.mocked(requestUrl).mockResolvedValue({ status: 500, text: 'down' } as any);
    await expect(c.closeTab('w1:t1')).rejects.toThrow('Herdr RPC tab.close failed (500): down');
  });

  it('unwraps snapshot responses with or without a snapshot envelope', async () => {
    const c = new HerdrClient({ host: 'laptop', token: 't' });
    vi.mocked(requestUrl).mockResolvedValueOnce({ status: 200, json: { snapshot: { tabs: [1] } } } as any);
    expect(await c.snapshot()).toEqual({ tabs: [1] });
    expect(req().url).toBe('http://laptop/s/herdr-obsidian/api/snapshot');
    vi.mocked(requestUrl).mockResolvedValueOnce({ status: 200, json: { tabs: [2] } } as any);
    expect(await c.snapshot()).toEqual({ tabs: [2] });
  });

  it('normalises createTab responses of different shapes', async () => {
    const c = new HerdrClient({ host: 'laptop', token: 't' });
    vi.mocked(requestUrl).mockResolvedValueOnce({ status: 200, json: { tab: { tab_id: 't1' }, root_pane: { pane_id: 'p1' } } } as any);
    expect(await c.createTab('w1', 'shell', false, { A: '1' })).toEqual({ tab: { tab_id: 't1' }, root_pane: { pane_id: 'p1' } });
    expect(JSON.parse(req().body)).toEqual({ workspace_id: 'w1', label: 'shell', focus: false, env: { A: '1' } });
    vi.mocked(requestUrl).mockResolvedValueOnce({ status: 200, json: { tab_id: 't2', pane_id: 'p2' } } as any);
    expect(await c.createTab('w1')).toEqual({ tab: { tab_id: 't2', pane_id: 'p2' }, root_pane: { pane_id: 'p2' } });
  });

  it('agentStart retries while the pane shell is not ready yet, and not on other errors', async () => {
    vi.useFakeTimers();
    const c = new HerdrClient({ host: 'laptop', token: 't' });
    vi.mocked(requestUrl)
      .mockResolvedValueOnce({ status: 500, text: 'pane w1:p1 is not an available shell' } as any)
      .mockResolvedValueOnce({ status: 200, json: { ok: true } } as any);
    const started = c.agentStart('n', 'claude', 'w1:p1');
    await vi.advanceTimersByTimeAsync(500);
    expect(await started).toEqual({ ok: true });
    expect(requestUrl).toHaveBeenCalledTimes(2);
    vi.mocked(requestUrl).mockResolvedValueOnce({ status: 500, text: 'unknown harness' } as any);
    await expect(c.agentStart('n', 'nope', 'p')).rejects.toThrow('unknown harness');
    expect(requestUrl).toHaveBeenCalledTimes(3);
  });

  it('only sends agent args when there are some', async () => {
    const c = new HerdrClient({ host: 'laptop', token: 't' });
    vi.mocked(requestUrl).mockResolvedValue({ status: 200, json: {} } as any);
    await c.agentStart('n', 'claude', 'p1');
    expect(JSON.parse(req().body)).toEqual({ name: 'n', kind: 'claude', pane_id: 'p1', timeout_ms: 60000 });
    await c.agentStart('n', 'claude', 'p1', ['--x'], 5);
    expect(JSON.parse(req().body).args).toEqual(['--x']);
  });

  it('subscribeEvents backs off while the bridge is unreachable, resetting once connected', async () => {
    vi.useFakeTimers();
    const c = new HerdrClient({ host: 'laptop', token: 't' });
    const unsub = await c.subscribeEvents(() => {});
    for (const ms of [1000, 2000, 4000, 8000]) {
      const n = FakeWebSocket.instances.length;
      FakeWebSocket.instances.at(-1)!.serverClose();
      vi.advanceTimersByTime(ms - 1);
      expect(FakeWebSocket.instances).toHaveLength(n);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(n + 1);
    }
    FakeWebSocket.instances.at(-1)!.open();
    FakeWebSocket.instances.at(-1)!.serverClose();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(6);
    // Unsubscribing cancels the pending retry.
    FakeWebSocket.instances.at(-1)!.serverClose();
    unsub();
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(6);
  });

  it('subscribeEvents forwards JSON events, ignores junk, reconnects, and stops on unsubscribe', async () => {
    vi.useFakeTimers();
    const c = new HerdrClient({ host: 'https://laptop', token: 't&x' });
    const cb = vi.fn();
    const unsub = await c.subscribeEvents(cb);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('wss://laptop/s/herdr-obsidian/ws/session?token=t%26x');
    ws.message('{"type":"tab.created"}');
    ws.message('not json');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ type: 'tab.created' });

    ws.serverClose();
    expect(cb).toHaveBeenLastCalledWith({ type: 'error', error: 'Bridge unreachable' });
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    unsub();
    FakeWebSocket.instances[1].serverClose();
    vi.advanceTimersByTime(10000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

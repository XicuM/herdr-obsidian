// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TerminalStream } from '../src/terminalStream';
import { FakeWebSocket } from './fakeWebSocket';

let callbacks: { onData: any; onExit: any; onError: any };
const text = (call: any[]) => new TextDecoder().decode(call[0]);

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  callbacks = { onData: vi.fn(), onExit: vi.fn(), onError: vi.fn() };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const start = (host = 'laptop:7788', cols = 120, rows = 40) => {
  const s = new TerminalStream(host, 'tok', 'herdr-obsidian', 'w1:p1', callbacks);
  s.start(cols, rows);
  return { s, ws: FakeWebSocket.instances[0] };
};

describe('TerminalStream', () => {
  it('opens the PTY socket with clamped size, token and takeover', () => {
    const { ws } = start('https://laptop/', 2, 1);
    expect(ws.url).toBe('wss://laptop/s/herdr-obsidian/ws/term/w1%3Ap1?cols=10&rows=5&token=tok&takeover=1');
    expect(ws.binaryType).toBe('arraybuffer');
  });

  it('is running only after the socket opens', () => {
    const { s, ws } = start();
    expect(s.isRunning).toBe(false);
    ws.open();
    expect(s.isRunning).toBe(true);
  });

  it('delivers binary frames, base64 JSON frames, and raw text', () => {
    const { ws } = start();
    const bin = new ArrayBuffer(3); // the page's own ArrayBuffer, as a WebSocket delivers it
    new Uint8Array(bin).set([98, 105, 110]);
    ws.message(bin);
    ws.message(JSON.stringify({ bytes: btoa('b64') }));
    ws.message('plain text');
    expect(callbacks.onData.mock.calls.map(text)).toEqual(['bin', 'b64', 'plain text']);
  });

  it("closes for good and reports the reason on the bridge's term-closed", () => {
    vi.useFakeTimers();
    const { s, ws } = start();
    ws.open();
    ws.message(JSON.stringify({ type: 'term-closed', reason: 'terminal attach taken over' }));
    expect(callbacks.onError).toHaveBeenCalledWith('terminal attach taken over');
    expect(s.isRunning).toBe(false);
    ws.message(new Uint8Array([1]).buffer);
    ws.serverClose(1000);
    vi.advanceTimersByTime(60_000);
    expect(callbacks.onData).not.toHaveBeenCalled();
    expect(callbacks.onExit).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1); // never steals the pane back
  });

  it('sends input as bytes, and resize/scroll as JSON, only while open', () => {
    const { s, ws } = start();
    s.sendInput('ignored');
    expect(ws.sent).toEqual([]);
    ws.open();
    s.sendInput('ls\r');
    s.sendInput(new Uint8Array([3]));
    s.resize(1, 100);
    s.scroll('up', 0, 4, 7);
    expect(new TextDecoder().decode(ws.sent[0])).toBe('ls\r');
    expect(ws.sent[1]).toEqual(new Uint8Array([3]));
    expect(JSON.parse(ws.sent[2])).toEqual({ cols: 10, rows: 100 });
    expect(JSON.parse(ws.sent[3])).toEqual({ type: 'terminal.scroll', direction: 'up', lines: 1, column: 4, row: 7 });
  });

  it('reports onExit once when it cannot connect, but not after a local close', () => {
    const a = start();
    a.ws.onerror?.({});
    a.ws.serverClose(1006);
    expect(callbacks.onExit).toHaveBeenCalledTimes(1);
    expect(callbacks.onExit).toHaveBeenCalledWith(1006);
    expect(callbacks.onError).not.toHaveBeenCalled();

    FakeWebSocket.instances = [];
    callbacks.onExit.mockClear();
    const b = start();
    b.s.close();
    b.ws.serverClose(1000);
    expect(callbacks.onExit).not.toHaveBeenCalled();
    b.s.start(80, 24);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('reconnects a dropped terminal with backoff, at its latest size', () => {
    vi.useFakeTimers();
    const { s, ws } = start();
    ws.open();
    s.resize(100, 30);
    ws.serverClose(1006);
    expect(callbacks.onExit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    const again = FakeWebSocket.instances[1];
    expect(again.url).toContain('cols=100&rows=30');
    // Retries 2 s, 4 s, 8 s, 16 s apart while the bridge stays away, then gives up.
    again.serverClose(1006);
    for (const ms of [2000, 4000, 8000, 16000]) {
      vi.advanceTimersByTime(ms);
      FakeWebSocket.instances.at(-1)!.serverClose(1006);
    }
    expect(FakeWebSocket.instances).toHaveLength(6);
    expect(callbacks.onExit).toHaveBeenCalledTimes(1);
  });

  it('a reconnect that works resets the backoff, and close() cancels a pending one', () => {
    vi.useFakeTimers();
    const { s, ws } = start();
    ws.open();
    ws.serverClose(1006);
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].serverClose(1006);
    s.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(callbacks.onExit).not.toHaveBeenCalled();
  });
});

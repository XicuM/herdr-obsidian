import { TerminalStreamCallbacks } from './terminalStream';

export class BridgeTerminalStream {
  private ws: WebSocket | null = null;
  private isClosed = false;
  private running = false;
  private wsBase: string;

  constructor(
    private host: string,
    private token: string,
    private session: string,
    private paneId: string,
    private callbacks: TerminalStreamCallbacks
  ) {
    let raw = host.trim().replace(/\/+$/, '');
    if (!raw.includes('://')) {
      raw = `http://${raw}`;
    }
    try {
      const u = new URL(raw);
      this.wsBase = `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
    } catch {
      this.wsBase = `ws://${host}`;
    }
  }

  get isRunning(): boolean {
    return this.running && !this.isClosed;
  }

  start(cols: number, rows: number) {
    if (this.isClosed) return;

    const url = `${this.wsBase}/s/${encodeURIComponent(this.session)}/ws/term/${encodeURIComponent(
      this.paneId
    )}?cols=${Math.max(10, cols)}&rows=${Math.max(5, rows)}&token=${encodeURIComponent(
      this.token
    )}&takeover=1`;

    try {
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.running = true;
      };

      this.ws.onmessage = (event: MessageEvent) => {
        if (this.isClosed) return;

        if (event.data instanceof ArrayBuffer) {
          this.callbacks.onData(new Uint8Array(event.data));
          return;
        }

        if (typeof event.data === 'string') {
          try {
            const frame = JSON.parse(event.data);
            if (frame.type === 'terminal.closed') {
              const reason = frame.reason || 'Terminal session closed';
              this.close();
              this.callbacks.onError(reason);
              return;
            }
            if (frame.bytes) {
              const buf = Uint8Array.from(atob(frame.bytes), (c) => c.charCodeAt(0));
              this.callbacks.onData(buf);
            }
          } catch {
            // Raw text fallback
            const enc = new TextEncoder();
            this.callbacks.onData(enc.encode(event.data));
          }
        }
      };

      this.ws.onerror = (e) => {
        if (!this.isClosed) {
          this.callbacks.onError('WebSocket error connecting to Herdr terminal');
        }
      };

      this.ws.onclose = (event) => {
        this.running = false;
        if (!this.isClosed) {
          this.isClosed = true;
          this.callbacks.onExit(event.code);
        }
      };
    } catch (err: any) {
      this.callbacks.onError(`Failed to open terminal WebSocket: ${err?.message || err}`);
    }
  }

  sendInput(data: string | Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      if (typeof data === 'string') {
        const enc = new TextEncoder();
        this.ws.send(enc.encode(data));
      } else {
        this.ws.send(data);
      }
    } catch {}
  }

  resize(cols: number, rows: number) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        JSON.stringify({
          cols: Math.max(10, cols),
          rows: Math.max(5, rows)
        })
      );
    } catch {}
  }

  scroll(direction: 'up' | 'down', lines: number, column?: number, row?: number) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        JSON.stringify({
          type: 'terminal.scroll',
          direction,
          lines: Math.max(1, lines),
          ...(column !== undefined ? { column } : {}),
          ...(row !== undefined ? { row } : {})
        })
      );
    } catch {}
  }

  close() {
    this.isClosed = true;
    this.running = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}

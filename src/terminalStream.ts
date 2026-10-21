export interface TerminalStreamCallbacks {
  onData: (data: Uint8Array) => void;
  onExit: (code: number | null) => void;
  onError: (err: string) => void;
}

/** Reconnects after a dropped connection this many times (1 s, 2 s, 4 s…) before giving up. */
const MAX_RETRIES = 5;

/** One pane's terminal, streamed through herdr-bridge's `/ws/term/<pane>` WebSocket. */
export class TerminalStream {
  private ws: WebSocket | null = null;
  private isClosed = false;
  private running = false;
  private wsBase: string;
  private cols = 80;
  private rows = 24;
  private retries = 0;
  private retryTimer: number | null = null;

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
    this.cols = cols;
    this.rows = rows;
    this.connect();
  }

  private connect() {
    const url = `${this.wsBase}/s/${encodeURIComponent(this.session)}/ws/term/${encodeURIComponent(
      this.paneId
    )}?cols=${Math.max(10, this.cols)}&rows=${Math.max(5, this.rows)}&token=${encodeURIComponent(
      this.token
    )}&takeover=1`;

    try {
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.running = true;
        this.retries = 0;
      };

      this.ws.onmessage = (event: MessageEvent) => {
        if (this.isClosed) return;

        if (event.data instanceof ArrayBuffer) {
          this.callbacks.onData(new Uint8Array(event.data));
          return;
        }

        if (typeof event.data === 'string') {
          try {
            const frame = JSON.parse(event.data) as { type?: string; reason?: string; bytes?: string };
            // The bridge says `term-closed` (e.g. another client took the pane over): no reconnecting.
            if (frame.type === 'term-closed' || frame.type === 'terminal.closed') {
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

      // A failed connection is always followed by onclose, which reports it once.
      this.ws.onclose = (event) => {
        const wasRunning = this.running;
        this.running = false;
        if (this.isClosed) return;
        // A blip on a working terminal (a phone switching networks): reconnect quietly a few times.
        if ((wasRunning || this.retries > 0) && this.retries < MAX_RETRIES) {
          this.retryTimer = window.setTimeout(() => this.connect(), 1000 * 2 ** this.retries++);
          return;
        }
        this.isClosed = true;
        this.callbacks.onExit(event.code);
      };
    } catch (err) {
      this.callbacks.onError(`Failed to open terminal WebSocket: ${(err as Error).message}`);
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
    } catch {
      // The socket closed meanwhile: its onclose reports it.
    }
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        JSON.stringify({
          cols: Math.max(10, cols),
          rows: Math.max(5, rows)
        })
      );
    } catch {
      // The socket closed meanwhile: its onclose reports it.
    }
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
    } catch {
      // The socket closed meanwhile: its onclose reports it.
    }
  }

  close() {
    this.isClosed = true;
    this.running = false;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Already closing.
      }
      this.ws = null;
    }
  }
}

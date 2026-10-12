import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export interface TerminalStreamCallbacks {
  onData: (data: Uint8Array) => void;
  onExit: (code: number | null) => void;
  onError: (err: string) => void;
}

export class HerdrTerminalStream {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private isClosed = false;

  constructor(
    private paneId: string,
    private session: string,
    private callbacks: TerminalStreamCallbacks
  ) {}

  start(cols: number, rows: number) {
    const sessionArgs = this.session ? ['--session', this.session] : [];
    const args = [
      ...sessionArgs,
      'terminal',
      'session',
      'control',
      this.paneId,
      '--takeover',
      '--cols',
      String(Math.max(10, cols)),
      '--rows',
      String(Math.max(5, rows))
    ];

    const sessionDir = this.session
      ? path.join(os.homedir(), '.config', 'herdr', 'sessions', this.session)
      : path.join(os.homedir(), '.config', 'herdr');
    const configPath = path.join(sessionDir, 'config.toml');
    const env = {
      ...process.env,
      ...(fs.existsSync(configPath) ? { HERDR_CONFIG_PATH: configPath } : {})
    };

    try {
      this.child = spawn('herdr', args, { env });
    } catch (err: any) {
      this.callbacks.onError(`Failed to spawn herdr: ${err?.message || err}`);
      return;
    }

    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          if (frame.type === 'terminal.closed') {
            if (frame.reason) {
              this.callbacks.onError(frame.reason);
            }
            this.close();
            return;
          }

          if (frame.bytes) {
            const buf = Buffer.from(frame.bytes, 'base64');
            this.callbacks.onData(new Uint8Array(buf));
          }
        } catch {
          // Ignore invalid JSON / partial lines
        }
      }
    });

    this.child.stderr.on('data', (chunk: Buffer) => {
      const errStr = chunk.toString('utf8');
      if (errStr.trim()) {
        this.callbacks.onError(errStr);
      }
    });

    this.child.on('close', (code) => {
      if (!this.isClosed) {
        this.isClosed = true;
        this.callbacks.onExit(code);
      }
    });

    this.child.on('error', (err) => {
      this.callbacks.onError(`Process error: ${err.message}`);
    });
  }

  sendInput(data: string | Uint8Array) {
    if (!this.child || this.isClosed || !this.child.stdin.writable) return;
    const b64 = typeof data === 'string'
      ? Buffer.from(data, 'utf8').toString('base64')
      : Buffer.from(data).toString('base64');
    const msg = JSON.stringify({ type: 'terminal.input', bytes: b64 }) + '\n';
    this.child.stdin.write(msg);
  }

  resize(cols: number, rows: number) {
    if (!this.child || this.isClosed || !this.child.stdin.writable) return;
    const msg = JSON.stringify({
      type: 'terminal.resize',
      cols: Math.max(10, cols),
      rows: Math.max(5, rows)
    }) + '\n';
    this.child.stdin.write(msg);
  }

  close() {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.child) {
      if (this.child.stdin.writable) {
        try {
          this.child.stdin.write(JSON.stringify({ type: 'terminal.release' }) + '\n');
          this.child.stdin.end();
        } catch {}
      }
      setTimeout(() => {
        try {
          this.child?.kill('SIGTERM');
        } catch {}
      }, 300);
    }
  }
}

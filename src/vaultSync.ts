import { App, TFile, Notice, normalizePath, requestUrl } from 'obsidian';

export interface RemoteFileInfo {
  path: string;
  mtime: number;
  size: number;
}

/**
 * Each side's mtime at the last sync: the phone's (ms) and the laptop's (s). Each is only ever
 * compared with the same side's, so the two clocks never need to agree.
 */
export interface SyncLedgerEntry {
  localMtime: number;
  remoteMtime: number;
}

export interface SyncLedger {
  [path: string]: SyncLedgerEntry;
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  deleted: number;
  errors: string[];
}

const EXCLUDED_DIRS = ['node_modules', 'target', 'dist', 'build', '__pycache__'];
const SYNCED_EXTENSIONS = ['md', 'canvas', 'txt', 'json', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf'];

/**
 * Notes, canvases and media outside hidden folders (`.obsidian` too: its settings are per device,
 * and hold this plugin's bridge token) and build folders. The bridge's `is_syncable` matches it.
 */
export function isSyncablePath(relPath: string): boolean {
  const parts = relPath.split('/');
  const name = parts.pop() ?? '';
  if (name.startsWith('.') || parts.some((p) => p.startsWith('.') || EXCLUDED_DIRS.includes(p))) return false;
  const dot = name.lastIndexOf('.');
  return dot > 0 && SYNCED_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  return x.every((v, i) => v === y[i]);
}

export class VaultSync {
  private httpBase: string;
  private token: string;
  private session: string;

  constructor(
    private app: App,
    host: string,
    token: string,
    session = 'herdr-obsidian'
  ) {
    let raw = host.trim().replace(/\/+$/, '');
    if (!raw.includes('://')) {
      raw = `http://${raw}`;
    }
    try {
      const u = new URL(raw);
      this.httpBase = `${u.protocol}//${u.host}`;
    } catch {
      this.httpBase = `http://${host}`;
    }
    this.token = token.trim();
    this.session = session;
  }

  /** The bridge serves the laptop's vault named like this one, so each phone vault syncs with its own. */
  private async request(method: string, endpoint: 'manifest' | 'file', path?: string, body?: ArrayBuffer) {
    const query = `vault=${encodeURIComponent(this.app.vault.getName())}${path !== undefined ? `&path=${encodeURIComponent(path)}` : ''}`;
    const res = await requestUrl({
      url: `${this.httpBase}/s/${encodeURIComponent(this.session)}/api/vault/${endpoint}?${query}`,
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/octet-stream' } : {})
      },
      body,
      throw: false
    });
    if (res.status >= 400 && !(method === 'DELETE' && res.status === 404)) {
      throw new Error(`${method} ${endpoint} failed (${res.status}): ${res.text}`);
    }
    return res;
  }

  async sync(ledger: SyncLedger): Promise<{ result: SyncResult; updatedLedger: SyncLedger }> {
    const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, deleted: 0, errors: [] };
    const updatedLedger: SyncLedger = { ...ledger };

    let remoteFiles: RemoteFileInfo[];
    try {
      remoteFiles = (await this.request('GET', 'manifest')).json as RemoteFileInfo[];
    } catch (err) {
      result.errors.push(`Manifest fetch failed: ${(err as Error).message}`);
      return { result, updatedLedger };
    }

    const remoteMap = new Map(remoteFiles.map((rf) => [rf.path, rf]));
    const localMap = new Map(
      this.app.vault.getFiles().filter((f) => isSyncablePath(f.path)).map((f) => [f.path, f])
    );
    const queue = [...new Set([...remoteMap.keys(), ...localMap.keys(), ...Object.keys(ledger)])];

    // A few files at a time: one request each, but not one round trip after another.
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
          try {
            await this.syncPath(path, localMap.get(path), remoteMap.get(path), updatedLedger, result);
          } catch (e) {
            result.errors.push(`${path}: ${(e as Error).message}`);
          }
        }
      })
    );

    return { result, updatedLedger };
  }

  /**
   * A side changed if it differs from the ledger (edited, created or deleted). A change on one side
   * is copied to the other. When both changed, the edited file always survives: the laptop's copy
   * wins the path (the agents work there), and the phone's, unless identical, is kept beside it.
   */
  private async syncPath(path: string, local: TFile | undefined, remote: RemoteFileInfo | undefined, ledger: SyncLedger, result: SyncResult) {
    const vault = this.app.vault;
    const prev = ledger[path];
    const localChanged = prev ? local?.stat.mtime !== prev.localMtime : !!local;
    const remoteChanged = prev ? remote?.mtime !== prev.remoteMtime : !!remote;
    if (!localChanged && !remoteChanged) return;

    if (local && remote && localChanged && remoteChanged) {
      const theirs = await this.download(path);
      const mine = await vault.readBinary(local);
      if (!sameBytes(theirs, mine)) {
        const dot = path.lastIndexOf('.');
        const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '');
        await vault.createBinary(normalizePath(`${path.slice(0, dot)}.conflict-phone-${stamp}${path.slice(dot)}`), mine);
        await vault.modifyBinary(local, theirs);
        result.conflicts++;
        new Notice(`⚠️ Sync conflict on "${path}" — kept the laptop's version, and yours as a conflict copy.`);
      }
      ledger[path] = { localMtime: await this.localMtime(path), remoteMtime: remote.mtime };
    } else if (remoteChanged && (remote || !localChanged)) {
      if (remote) {
        const data = await this.download(path);
        if (local) {
          await vault.modifyBinary(local, data);
        } else {
          const parent = path.substring(0, path.lastIndexOf('/'));
          if (parent && !vault.getFolderByPath(parent)) {
            await vault.createFolder(parent).catch(() => {
              // Another transfer may be creating the same folder.
            });
          }
          await vault.createBinary(path, data);
        }
        ledger[path] = { localMtime: await this.localMtime(path), remoteMtime: remote.mtime };
        result.pulled++;
      } else {
        // Into the user's trash (Obsidian's or the system's, per their setting), never gone for good.
        await this.app.fileManager.trashFile(local);
        delete ledger[path];
        result.deleted++;
      }
    } else if (local) {
      const localMtime = local.stat.mtime;
      const res = await this.request('POST', 'file', path, await vault.readBinary(local));
      ledger[path] = { localMtime, remoteMtime: (res.json as { mtime: number }).mtime };
      result.pushed++;
    } else {
      if (remote) {
        await this.request('DELETE', 'file', path);
        result.deleted++;
      }
      delete ledger[path];
    }
  }

  /**
   * The file's mtime as just written. Read from the adapter: the vault's cached `TFile.stat` may not
   * reflect a write yet, and recording a stale one would make the next sync push the file back.
   */
  private async localMtime(path: string): Promise<number> {
    const stat = await this.app.vault.adapter.stat(path);
    if (!stat) throw new Error('missing right after writing it');
    return stat.mtime;
  }

  private async download(path: string): Promise<ArrayBuffer> {
    return (await this.request('GET', 'file', path)).arrayBuffer;
  }
}

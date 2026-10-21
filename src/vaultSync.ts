import { App, TFile, Notice, requestUrl } from 'obsidian';

export interface RemoteFileInfo {
  path: string;
  mtime: number;
  size: number;
}

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

  private isSyncablePath(relPath: string): boolean {
    const parts = relPath.split(/[\\/]/);
    for (const p of parts) {
      if (
        p === '.git' ||
        p === 'node_modules' ||
        p === 'target' ||
        p === '.venv' ||
        p === 'dist' ||
        p === 'build' ||
        p === '__pycache__'
      ) {
        return false;
      }
      if (p.startsWith('.') && p !== '.obsidian') {
        return false;
      }
    }
    const ext = relPath.split('.').pop()?.toLowerCase();
    if (!ext) return false;
    return [
      'md',
      'canvas',
      'txt',
      'json',
      'csv',
      'png',
      'jpg',
      'jpeg',
      'gif',
      'svg',
      'webp',
      'pdf'
    ].includes(ext);
  }

  async fetchManifest(workspaceId: string): Promise<RemoteFileInfo[]> {
    const url = `${this.httpBase}/s/${encodeURIComponent(this.session)}/api/vault/manifest?workspace_id=${encodeURIComponent(
      workspaceId
    )}`;
    const res = await requestUrl({
      url,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });
    if (res.status >= 400) {
      throw new Error(`Failed to fetch manifest (${res.status}): ${res.text}`);
    }
    return res.json as RemoteFileInfo[];
  }

  async downloadFile(workspaceId: string, path: string): Promise<ArrayBuffer> {
    const url = `${this.httpBase}/s/${encodeURIComponent(this.session)}/api/vault/file?workspace_id=${encodeURIComponent(
      workspaceId
    )}&path=${encodeURIComponent(path)}`;
    const res = await requestUrl({
      url,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });
    if (res.status >= 400) {
      throw new Error(`Failed to download ${path} (${res.status}): ${res.text}`);
    }
    return res.arrayBuffer;
  }

  async uploadFile(workspaceId: string, path: string, content: ArrayBuffer | string): Promise<void> {
    const url = `${this.httpBase}/s/${encodeURIComponent(this.session)}/api/vault/file?workspace_id=${encodeURIComponent(
      workspaceId
    )}&path=${encodeURIComponent(path)}`;
    const res = await requestUrl({
      url,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/octet-stream'
      },
      body: content
    });
    if (res.status >= 400) {
      throw new Error(`Failed to upload ${path} (${res.status}): ${res.text}`);
    }
  }

  async deleteRemoteFile(workspaceId: string, path: string): Promise<void> {
    const url = `${this.httpBase}/s/${encodeURIComponent(this.session)}/api/vault/file?workspace_id=${encodeURIComponent(
      workspaceId
    )}&path=${encodeURIComponent(path)}`;
    const res = await requestUrl({
      url,
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });
    if (res.status >= 400 && res.status !== 404) {
      throw new Error(`Failed to delete remote ${path} (${res.status}): ${res.text}`);
    }
  }

  async sync(workspaceId: string, ledger: SyncLedger): Promise<{ result: SyncResult; updatedLedger: SyncLedger }> {
    const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, deleted: 0, errors: [] };
    const updatedLedger: SyncLedger = { ...ledger };

    let remoteFiles: RemoteFileInfo[];
    try {
      remoteFiles = await this.fetchManifest(workspaceId);
    } catch (err: any) {
      result.errors.push(`Manifest fetch failed: ${err.message}`);
      return { result, updatedLedger };
    }

    const remoteMap = new Map<string, RemoteFileInfo>();
    for (const rf of remoteFiles) {
      remoteMap.set(rf.path, rf);
    }

    // 1. Scan local files
    const localFiles = this.app.vault.getFiles().filter((f) => this.isSyncablePath(f.path));
    const localMap = new Map<string, TFile>();
    for (const lf of localFiles) {
      localMap.set(lf.path, lf);
    }

    // 2. Process Remote Files (Pull, Conflict, or Local-Delete)
    for (const [path, rf] of remoteMap) {
      const localFile = localMap.get(path);
      const prevSync = updatedLedger[path];

      if (!localFile) {
        if (prevSync) {
          // File was previously synced, but now deleted locally -> delete on remote
          try {
            await this.deleteRemoteFile(workspaceId, path);
            delete updatedLedger[path];
            result.deleted++;
          } catch (e: any) {
            result.errors.push(`Failed to delete remote ${path}: ${e.message}`);
          }
        } else {
          // Brand new remote file -> download
          try {
            const buf = await this.downloadFile(workspaceId, path);
            const parent = path.substring(0, path.lastIndexOf('/'));
            if (parent && !this.app.vault.getAbstractFileByPath(parent)) {
              await this.app.vault.createFolder(parent);
            }
            const isText = path.endsWith('.md') || path.endsWith('.txt') || path.endsWith('.json') || path.endsWith('.canvas') || path.endsWith('.csv');
            let created: TFile;
            if (isText) {
              const text = new TextDecoder().decode(buf);
              created = await this.app.vault.create(path, text);
            } else {
              created = await this.app.vault.createBinary(path, buf);
            }
            updatedLedger[path] = {
              localMtime: Math.floor(created.stat.mtime / 1000),
              remoteMtime: rf.mtime
            };
            result.pulled++;
          } catch (e: any) {
            result.errors.push(`Failed to pull ${path}: ${e.message}`);
          }
        }
      } else {
        // Exists both locally and remotely
        const localSecs = Math.floor(localFile.stat.mtime / 1000);
        const remoteSecs = rf.mtime;

        if (!prevSync) {
          // First time tracking: if identical mtime or local newer, push; else pull
          if (localSecs > remoteSecs) {
            try {
              const buf = await this.app.vault.readBinary(localFile);
              await this.uploadFile(workspaceId, path, buf);
              updatedLedger[path] = { localMtime: localSecs, remoteMtime: localSecs };
              result.pushed++;
            } catch (e: any) {
              result.errors.push(`Failed to push ${path}: ${e.message}`);
            }
          } else if (remoteSecs > localSecs) {
            try {
              const buf = await this.downloadFile(workspaceId, path);
              await this.app.vault.modifyBinary(localFile, buf);
              updatedLedger[path] = { localMtime: Math.floor(localFile.stat.mtime / 1000), remoteMtime: remoteSecs };
              result.pulled++;
            } catch (e: any) {
              result.errors.push(`Failed to pull ${path}: ${e.message}`);
            }
          } else {
            updatedLedger[path] = { localMtime: localSecs, remoteMtime: remoteSecs };
          }
        } else {
          const localChanged = localSecs > prevSync.localMtime;
          const remoteChanged = remoteSecs > prevSync.remoteMtime;

          if (localChanged && remoteChanged) {
            // CONFLICT! Both modified independently since last sync.
            result.conflicts++;
            try {
              const remoteBuf = await this.downloadFile(workspaceId, path);
              const localBuf = await this.app.vault.readBinary(localFile);

              // Date stamp for conflict filename
              const dateStr = new Date().toISOString().slice(0, 10);
              const dotIdx = path.lastIndexOf('.');
              const baseName = dotIdx !== -1 ? path.slice(0, dotIdx) : path;
              const ext = dotIdx !== -1 ? path.slice(dotIdx) : '';
              const conflictPath = `${baseName}.conflict-phone-${dateStr}${ext}`;

              if (remoteSecs >= localSecs) {
                // Remote is newer: keep remote as primary, save local copy as conflict
                await this.app.vault.createBinary(conflictPath, localBuf);
                await this.app.vault.modifyBinary(localFile, remoteBuf);
              } else {
                // Local is newer: keep local as primary, save remote copy as conflict
                await this.app.vault.createBinary(conflictPath, remoteBuf);
                await this.uploadFile(workspaceId, path, localBuf);
              }

              updatedLedger[path] = {
                localMtime: Math.floor(localFile.stat.mtime / 1000),
                remoteMtime: Math.max(localSecs, remoteSecs)
              };

              new Notice(`⚠️ Sync conflict on "${path}" — conflict copy created.`);
            } catch (e: any) {
              result.errors.push(`Conflict resolution failed for ${path}: ${e.message}`);
            }
          } else if (remoteChanged) {
            // Remote changed only -> pull
            try {
              const buf = await this.downloadFile(workspaceId, path);
              await this.app.vault.modifyBinary(localFile, buf);
              updatedLedger[path] = {
                localMtime: Math.floor(localFile.stat.mtime / 1000),
                remoteMtime: remoteSecs
              };
              result.pulled++;
            } catch (e: any) {
              result.errors.push(`Failed to pull ${path}: ${e.message}`);
            }
          } else if (localChanged) {
            // Local changed only -> push
            try {
              const buf = await this.app.vault.readBinary(localFile);
              await this.uploadFile(workspaceId, path, buf);
              updatedLedger[path] = {
                localMtime: localSecs,
                remoteMtime: localSecs
              };
              result.pushed++;
            } catch (e: any) {
              result.errors.push(`Failed to push ${path}: ${e.message}`);
            }
          }
        }
      }
    }

    // 3. Process Local Files Not in Remote Manifest (New Local Files or Remote Deletions)
    for (const [path, localFile] of localMap) {
      if (!remoteMap.has(path)) {
        const prevSync = updatedLedger[path];
        if (prevSync) {
          // Was previously synced, now gone from remote -> delete locally
          try {
            await this.app.vault.delete(localFile);
            delete updatedLedger[path];
            result.deleted++;
          } catch (e: any) {
            result.errors.push(`Failed to delete local ${path}: ${e.message}`);
          }
        } else {
          // Brand new local file -> upload to remote
          try {
            const buf = await this.app.vault.readBinary(localFile);
            await this.uploadFile(workspaceId, path, buf);
            const localSecs = Math.floor(localFile.stat.mtime / 1000);
            updatedLedger[path] = {
              localMtime: localSecs,
              remoteMtime: localSecs
            };
            result.pushed++;
          } catch (e: any) {
            result.errors.push(`Failed to push ${path}: ${e.message}`);
          }
        }
      }
    }

    return { result, updatedLedger };
  }
}

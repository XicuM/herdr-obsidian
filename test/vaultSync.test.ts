import { describe, it, expect, beforeEach, vi } from 'vitest';
import { requestUrl, TFile } from 'obsidian';
import { VaultSync, SyncLedger, RemoteChange, isSyncablePath } from '../src/vaultSync';

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

// In-memory bridge and vault, on deliberately unrelated clocks: the laptop's in seconds, the phone's
// in ms and hours off. Sync must never compare one with the other.
let laptopNow: number; // s
let phoneNow: number; // ms
let remote: Map<string, { mtime: number; mtimeMs: number; data: ArrayBuffer }>;
/** Whether the bridge sends `mtime_ms`, as one with live sync does. */
let msBridge: boolean;
let laptopMs: number; // the ms within laptopNow's second, moving on with each write
let local: Map<string, { file: TFile; data: ArrayBuffer }>;
let requests: { method: string; url: URL; headers: any }[];
let failPaths: Set<string>;

const vault = {
  getName: () => 'Personal',
  adapter: { stat: async (p: string) => ({ mtime: local.get(p)!.file.stat.mtime }) },
  getFiles: () => [...local.values()].map((e) => e.file),
  getFolderByPath: (p: string) => ([...local.keys()].some((k) => k.startsWith(p + '/')) ? {} : null),
  createFolder: vi.fn(async () => {}),
  createBinary: async (p: string, data: ArrayBuffer) => {
    if (local.has(p)) throw new Error('File already exists.');
    const file = new TFile(p, phoneNow);
    local.set(p, { file, data });
    return file;
  },
  readBinary: async (f: TFile) => local.get(f.path)!.data,
  modifyBinary: async (f: TFile, data: ArrayBuffer) => {
    const e = local.get(f.path)!;
    e.data = data;
    e.file.stat.mtime = phoneNow;
  },
};
const app = {
  vault,
  fileManager: {
    trashFile: async (f: TFile) => {
      local.delete(f.path);
    }
  }
} as any;

const putLocal = (p: string, text: string) => local.set(p, { file: new TFile(p, phoneNow), data: enc(text) });
const putRemote = (p: string, text: string) => remote.set(p, { mtime: laptopNow, mtimeMs: laptopNow * 1000 + ++laptopMs, data: enc(text) });
/** The file as the bridge lists it. */
const remoteInfo = (p: string) => {
  const r = remote.get(p)!;
  return { path: p, mtime: r.mtime, size: r.data.byteLength, ...(msBridge ? { mtime_ms: r.mtimeMs } : {}) };
};
const localText = (p: string) => (local.has(p) ? dec(local.get(p)!.data) : undefined);
const remoteText = (p: string) => (remote.has(p) ? dec(remote.get(p)!.data) : undefined);
const tick = () => {
  laptopNow += 60;
  phoneNow += 60_000;
};

beforeEach(() => {
  laptopNow = 1_000_000;
  laptopMs = 0;
  msBridge = false;
  phoneNow = 5_000_000_000_000;
  remote = new Map();
  local = new Map();
  requests = [];
  failPaths = new Set();
  vi.mocked(requestUrl).mockReset();
  vi.mocked(requestUrl).mockImplementation((async ({ url, method, headers, body }: any) => {
    const u = new URL(url);
    requests.push({ method, url: u, headers });
    const p = u.searchParams.get('path')!;
    if (failPaths.has(p)) return { status: 500, text: 'boom' };
    if (u.pathname.endsWith('/manifest')) {
      return { status: 200, json: [...remote.keys()].map(remoteInfo) };
    }
    if (method === 'GET') return remote.has(p) ? { status: 200, arrayBuffer: remote.get(p)!.data } : { status: 404, text: 'nope' };
    if (method === 'POST') {
      // Like the bridge: the file gets the laptop's clock, which the response reports.
      remote.set(p, { mtime: laptopNow, mtimeMs: laptopNow * 1000 + ++laptopMs, data: body });
      const { mtime, mtime_ms } = remoteInfo(p);
      return { status: 200, json: { mtime, mtime_ms } };
    }
    if (method === 'DELETE') return remote.delete(p) ? { status: 200 } : { status: 404, text: 'nope' };
  }) as any);
});

const sync = async (ledger: SyncLedger = {}, changes?: RemoteChange[]) => {
  const out = await new VaultSync(app, 'laptop.ts.net:7788/', ' tok ').sync(ledger, changes);
  tick();
  return out;
};
/** Syncs, then returns the ledger: both sides now agree. */
const synced = async () => (await sync()).updatedLedger;

describe('isSyncablePath', () => {
  it('syncs notes and media outside hidden and build folders', () => {
    expect(['a.md', 'notes/deep/b.canvas', 'img/c.PNG'].filter(isSyncablePath)).toHaveLength(3);
    const skipped = ['.obsidian/plugins/herdr-obsidian/data.json', '.obsidian/app.json', '.git/x.md', 'node_modules/x.md', '.trash/a.md', '.hidden.md', 'src/main.rs', 'Makefile', 'md'];
    expect(skipped.filter(isSyncablePath)).toEqual([]);
  });
});

describe('VaultSync requests', () => {
  it('normalises the host and sends the bearer token, session and vault name', async () => {
    putLocal('my notes/a b.md', 'x');
    await sync();
    const r = requests[0];
    expect(r.url.origin).toBe('http://laptop.ts.net:7788');
    expect(r.url.pathname).toBe('/s/herdr-obsidian/api/vault/manifest');
    expect(r.url.searchParams.get('vault')).toBe('Personal');
    expect(requests[1].url.searchParams.get('vault')).toBe('Personal');
    expect(requests[1].url.searchParams.get('path')).toBe('my notes/a b.md');
    expect(r.headers.Authorization).toBe('Bearer tok');
  });

  it('keeps https hosts', async () => {
    await new VaultSync(app, 'https://bridge.example', 't').sync({});
    expect(requests[0].url.origin).toBe('https://bridge.example');
  });

  it('reports a manifest failure without touching anything', async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({ status: 404, text: 'No Obsidian vault named "Personal" on this machine' } as any);
    putLocal('a.md', 'x');
    const ledger = { 'a.md': { localMtime: 1, remoteMtime: 1 } };
    const { result, updatedLedger } = await sync(ledger);
    expect(result.errors).toEqual(['Manifest fetch failed: GET manifest failed (404): No Obsidian vault named "Personal" on this machine']);
    expect(updatedLedger).toEqual(ledger);
    expect(localText('a.md')).toBe('x');
  });
});

describe('VaultSync first sync', () => {
  it('pulls new remote files, creating parent folders', async () => {
    putRemote('notes/deep/a.md', 'remote text');
    vault.createFolder.mockClear();
    putRemote('img.png', 'PNG');
    const { result, updatedLedger } = await sync();
    expect(result).toMatchObject({ pulled: 2, pushed: 0, errors: [] });
    expect(localText('notes/deep/a.md')).toBe('remote text');
    expect(localText('img.png')).toBe('PNG');
    expect(vault.createFolder.mock.calls).toEqual([['notes/deep']]); // none for the root-level img.png
    expect(updatedLedger['notes/deep/a.md']).toEqual({ localMtime: phoneNow - 60_000, remoteMtime: laptopNow - 60 });
  });

  it('pushes new local files, recording the mtime the laptop reports', async () => {
    putLocal('a.md', 'local');
    const { result, updatedLedger } = await sync();
    expect(result).toMatchObject({ pulled: 0, pushed: 1 });
    expect(remoteText('a.md')).toBe('local');
    expect(updatedLedger['a.md']).toEqual({ localMtime: phoneNow - 60_000, remoteMtime: laptopNow - 60 });
  });

  it('files on both sides: identical ones are just recorded, different ones conflict', async () => {
    putLocal('same.md', 'x');
    putRemote('same.md', 'x');
    putLocal('diff.md', 'mine');
    putRemote('diff.md', 'theirs');
    const { result, updatedLedger } = await sync();
    expect(result).toMatchObject({ pulled: 0, pushed: 0, conflicts: 1 });
    expect(updatedLedger['same.md']).toBeDefined();
    expect(localText('diff.md')).toBe('theirs');
    expect([...local.keys()].find((k) => k.startsWith('diff.conflict-phone-'))).toMatch(/^diff\.conflict-phone-\d{4}-\d\d-\d\dT\d{6}\.md$/);
  });

  it('never syncs .obsidian, so the bridge token in data.json stays on the phone', async () => {
    putLocal('.obsidian/plugins/herdr-obsidian/data.json', '{"bridgeToken":"secret"}');
    await sync();
    expect(remote.size).toBe(0);
  });
});

describe('VaultSync incremental sync', () => {
  let ledger: SyncLedger;

  beforeEach(async () => {
    putLocal('a.md', 'v1');
    putRemote('a.md', 'v1');
    ledger = await synced();
  });

  it('does nothing when neither side changed', async () => {
    requests = [];
    const { result } = await sync(ledger);
    expect(result).toMatchObject({ pulled: 0, pushed: 0, conflicts: 0, deleted: 0 });
    expect(requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('pushes a local-only change', async () => {
    putLocal('a.md', 'v2 local');
    expect((await sync(ledger)).result.pushed).toBe(1);
    expect(remoteText('a.md')).toBe('v2 local');
  });

  it('pulls a remote-only change', async () => {
    putRemote('a.md', 'v2 remote');
    expect((await sync(ledger)).result.pulled).toBe(1);
    expect(localText('a.md')).toBe('v2 remote');
  });

  it('after a push or a pull, the next sync is a no-op', async () => {
    putLocal('a.md', 'v2 local');
    const afterPush = await sync(ledger);
    expect((await sync(afterPush.updatedLedger)).result).toMatchObject({ pulled: 0, pushed: 0 });
    putRemote('a.md', 'v3 remote');
    const afterPull = await sync(afterPush.updatedLedger);
    expect((await sync(afterPull.updatedLedger)).result).toMatchObject({ pulled: 0, pushed: 0 });
  });

  it('on conflict the laptop wins the path and the phone keeps its edit as a copy, whatever the clocks say', async () => {
    putRemote('a.md', 'theirs');
    phoneNow += 10 * 3600_000; // the phone's clock is hours ahead: irrelevant
    putLocal('a.md', 'mine');
    const { result } = await sync(ledger);
    expect(result.conflicts).toBe(1);
    expect(localText('a.md')).toBe('theirs');
    expect(remoteText('a.md')).toBe('theirs');
    expect(localText([...local.keys()].find((k) => k.includes('.conflict-phone-'))!)).toBe('mine');
  });

  it('identical edits on both sides are not a conflict', async () => {
    putRemote('a.md', 'same');
    putLocal('a.md', 'same');
    const { result } = await sync(ledger);
    expect(result.conflicts).toBe(0);
    expect(local.size).toBe(1);
  });

  it('propagates a local deletion to the laptop', async () => {
    local.delete('a.md');
    const { result, updatedLedger } = await sync(ledger);
    expect(result.deleted).toBe(1);
    expect(remote.has('a.md')).toBe(false);
    expect(updatedLedger).toEqual({});
  });

  it('propagates a laptop deletion to the phone', async () => {
    remote.delete('a.md');
    const { result, updatedLedger } = await sync(ledger);
    expect(result.deleted).toBe(1);
    expect(local.has('a.md')).toBe(false);
    expect(updatedLedger).toEqual({});
  });

  it('a laptop deletion never deletes a file edited on the phone: it is restored on the laptop', async () => {
    remote.delete('a.md');
    putLocal('a.md', 'unsynced phone edit');
    await sync(ledger);
    expect(localText('a.md')).toBe('unsynced phone edit');
    expect(remoteText('a.md')).toBe('unsynced phone edit');
  });

  it('a phone deletion never deletes a file edited on the laptop: it is restored on the phone', async () => {
    local.delete('a.md');
    putRemote('a.md', 'unsynced laptop edit');
    await sync(ledger);
    expect(remoteText('a.md')).toBe('unsynced laptop edit');
    expect(localText('a.md')).toBe('unsynced laptop edit');
  });

  it('forgets files deleted on both sides', async () => {
    local.delete('a.md');
    remote.delete('a.md');
    const { result, updatedLedger } = await sync(ledger);
    expect(result).toMatchObject({ deleted: 0, errors: [] });
    expect(updatedLedger).toEqual({});
  });

  it('collects per-file errors and keeps the old ledger entry', async () => {
    putRemote('a.md', 'v2');
    failPaths.add('a.md');
    const { result, updatedLedger } = await sync(ledger);
    expect(result.errors).toEqual(['a.md: GET file failed (500): boom']);
    expect(updatedLedger).toEqual(ledger);
  });

  it('transfers several files at once', async () => {
    for (let i = 0; i < 10; i++) putRemote(`n${i}.md`, `${i}`);
    let inFlight = 0;
    let peak = 0;
    const impl = vi.mocked(requestUrl).getMockImplementation()!;
    vi.mocked(requestUrl).mockImplementation((async (req: any) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return impl(req);
    }) as any);
    expect((await sync(ledger)).result.pulled).toBe(10);
    expect(peak).toBe(4);
  });
});

describe('VaultSync with a bridge that sends ms', () => {
  /** Syncs without moving the clocks on, as two syncs within a second do. */
  const syncNow = (ledger: SyncLedger) => new VaultSync(app, 'laptop', 'tok').sync(ledger);

  it('pulls a second laptop edit made within the same second, which an old bridge misses', async () => {
    for (const ms of [false, true]) {
      msBridge = ms;
      remote.clear();
      local.clear();
      putRemote('a.md', 'v1');
      const { updatedLedger } = await syncNow({});
      putRemote('a.md', 'v2');
      const { result } = await syncNow(updatedLedger);
      expect([ms, result.pulled, localText('a.md')]).toEqual(ms ? [true, 1, 'v2'] : [false, 0, 'v1']);
    }
  });

  it('takes over a ledger from before ms without transferring anything', async () => {
    putLocal('a.md', 'v1');
    putRemote('a.md', 'v1');
    const ledger = await synced();
    expect(ledger['a.md'].remoteMtimeMs).toBeUndefined();
    msBridge = true;
    requests = [];
    const { result, updatedLedger } = await sync(ledger);
    expect(result).toMatchObject({ pulled: 0, pushed: 0, conflicts: 0, deleted: 0 });
    expect(requests.map((r) => r.method)).toEqual(['GET']); // the manifest only
    expect(updatedLedger['a.md']).toEqual({ ...ledger['a.md'], remoteMtimeMs: remote.get('a.md')!.mtimeMs });
  });

  describe('changes the bridge pushed', () => {
    let ledger: SyncLedger;
    beforeEach(async () => {
      msBridge = true;
      for (const p of ['a.md', 'b.md']) {
        putLocal(p, 'v1');
        putRemote(p, 'v1');
      }
      ledger = await synced();
      requests = [];
    });

    it('applies just those files, without fetching the manifest', async () => {
      putRemote('a.md', 'v2');
      remote.delete('b.md');
      putRemote('.obsidian/workspace.json', '{}');
      const changes = [remoteInfo('a.md'), { path: 'b.md', deleted: true as const }, remoteInfo('.obsidian/workspace.json')];
      const { result } = await sync(ledger, changes);
      expect(result).toMatchObject({ pulled: 1, deleted: 1, errors: [] });
      expect(requests.map((r) => `${r.method} ${r.url.searchParams.get('path')}`)).toEqual(['GET a.md']);
      expect(localText('a.md')).toBe('v2');
      expect(local.has('b.md')).toBe(false);
      expect(local.has('.obsidian/workspace.json')).toBe(false);
    });

    it("ignores the echo of the phone's own upload", async () => {
      putLocal('a.md', 'phone edit');
      const { updatedLedger } = await sync(ledger);
      requests = [];
      const { result } = await sync(updatedLedger, [remoteInfo('a.md')]);
      expect(result).toMatchObject({ pulled: 0, pushed: 0, conflicts: 0 });
      expect(requests).toEqual([]);
    });

    it('keeps a phone edit that crossed a pushed laptop edit, as a conflict copy', async () => {
      putRemote('a.md', 'laptop');
      putLocal('a.md', 'phone');
      const { result } = await sync(ledger, [remoteInfo('a.md')]);
      expect(result.conflicts).toBe(1);
      expect(localText('a.md')).toBe('laptop');
      expect(localText([...local.keys()].find((k) => k.includes('.conflict-phone-'))!)).toBe('phone');
    });
  });
});

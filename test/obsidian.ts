// Minimal runtime stand-in for the `obsidian` module (aliased in vitest.config.mjs).
import { vi } from 'vitest';

export const Platform = { isDesktop: true, isMobile: false };

export const notices: string[] = [];
export class Notice {
  constructor(message: string) {
    notices.push(message);
  }
}

export const requestUrl = vi.fn();
export const normalizePath = (p: string) => p;

export class TAbstractFile {
  path: string = '';
}

export class TFile extends TAbstractFile {
  stat: { mtime: number; ctime: number; size: number };
  constructor(path: string, mtime: number) {
    super();
    this.path = path;
    this.stat = { mtime, ctime: mtime, size: 0 };
  }
}

export class TFolder extends TAbstractFile {
  children: any[] = [];
  constructor(path: string) {
    super();
    this.path = path;
  }
}

export class FileSystemAdapter {
  constructor(private basePath: string) {}
  getBasePath() {
    return this.basePath;
  }
}

export class Plugin {
  app: any;
  manifest: any;
  constructor(app: any, manifest: any) {
    this.app = app;
    this.manifest = manifest;
  }
  async loadData() {
    return null;
  }
  async saveData(_data: any) {}
}

export class ItemView {
  leaf: any;
  containerEl: any;
  app: any;
  registerEvent(_ref: any) {}
  constructor(leaf: any) {
    this.leaf = leaf;
  }
}

export class Modal {
  app: any;
  constructor(app: any) {
    this.app = app;
  }
}
export class FuzzySuggestModal<T> extends Modal {}
export class PluginSettingTab {}
export class Setting {}
export class Menu {}
export const setIcon = () => {};
export type App = any;
export type WorkspaceLeaf = any;

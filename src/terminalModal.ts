import { App, Modal, Setting } from 'obsidian';
import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';

export interface TerminalConfig {
  command: string;
  cwd: string;
}

export function launchTerminal(app: App, defaultCommand: string, defaultCwd: string, terminalApp = 'default') {
  const modal = new TerminalChoiceModal(app, defaultCommand, defaultCwd, terminalApp);
  modal.open();
}

export class TerminalChoiceModal extends Modal {
  private command: string;
  private cwd: string;
  private terminalApp: string;

  constructor(app: App, defaultCommand: string, defaultCwd: string, terminalApp: string) {
    super(app);
    this.command = defaultCommand;
    this.cwd = defaultCwd;
    this.terminalApp = terminalApp;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Open Herdr Terminal' });
    contentEl.createEl('p', {
      text: 'Herdr is a full TUI application. Choose an action below:',
      cls: 'setting-item-description'
    });

    new Setting(contentEl)
      .setName('Launch in Desktop Terminal')
      .setDesc('Spawns Herdr in an external terminal window (Alacritty / default terminal).')
      .addButton((btn) =>
        btn
          .setButtonText('Launch Terminal')
          .setCta()
          .onClick(() => {
            this.spawnExternalTerminal();
            this.close();
          })
      );

    new Setting(contentEl)
      .setName('Focus Desktop Window (Hyprland / Omarchy)')
      .setDesc('Brings an already running Herdr window to the active workspace.')
      .addButton((btn) =>
        btn.setButtonText('Focus Window').onClick(() => {
          this.focusDesktopWindow();
          this.close();
        })
      );

    new Setting(contentEl)
      .setName('Copy CLI Command')
      .setDesc(this.command)
      .addButton((btn) =>
        btn.setButtonText('Copy').onClick(async () => {
          await navigator.clipboard.writeText(this.command);
          btn.setButtonText('Copied!');
          setTimeout(() => btn.setButtonText('Copy'), 2000);
        })
      );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }

  private focusDesktopWindow() {
    const script = path.join(os.homedir(), '.local', 'bin', 'omarchy-launch-or-move-herdr');
    try {
      const child = spawn(script, [], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch {
      // Fallback: spawn hyprctl or terminal directly
      this.spawnExternalTerminal();
    }
  }

  private spawnExternalTerminal() {
    // If user specified an explicit terminal command
    if (this.terminalApp && this.terminalApp !== 'default') {
      const parts = this.terminalApp.split(' ');
      const bin = parts[0];
      const args = [...parts.slice(1), '-e', 'sh', '-c', `cd "${this.cwd}" && ${this.command}`];
      const child = spawn(bin, args, { cwd: this.cwd, detached: true, stdio: 'ignore' });
      child.unref();
      return;
    }

    // Try omarchy launcher first if available
    const omarchyLauncher = path.join(os.homedir(), '.local', 'bin', 'omarchy-launch-or-move-herdr');
    try {
      const child = spawn(omarchyLauncher, [], { detached: true, stdio: 'ignore' });
      child.unref();
      return;
    } catch {}

    // Fall back to alacritty, xdg-terminal-exec, or xterm
    const fallbacks = [
      { bin: 'alacritty', args: ['-e', 'sh', '-c', `cd "${this.cwd}" && ${this.command}`] },
      { bin: 'xdg-terminal-exec', args: ['-e', 'sh', '-c', `cd "${this.cwd}" && ${this.command}`] },
      { bin: 'xterm', args: ['-e', 'sh', '-c', `cd "${this.cwd}" && ${this.command}`] }
    ];

    for (const term of fallbacks) {
      try {
        const child = spawn(term.bin, term.args, { cwd: this.cwd, detached: true, stdio: 'ignore' });
        child.unref();
        return;
      } catch {}
    }
  }
}

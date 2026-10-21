import { App, Modal, Setting, Notice } from 'obsidian';

export class RenameTabModal extends Modal {
  private currentName: string;
  private onRename: (newName: string) => void;
  private submitted = false;

  constructor(app: App, currentName: string, onRename: (newName: string) => void) {
    super(app);
    this.currentName = currentName;
    this.onRename = onRename;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle('Rename tab');

    let newName = this.currentName;

    new Setting(contentEl)
      .setName('Tab name')
      .addText((text) => {
        text.setValue(this.currentName).onChange((val) => {
          newName = val;
        });
        text.inputEl.setAttribute('maxlength', '80');
        text.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.submit(newName);
          }
        });
        window.setTimeout(() => {
          text.inputEl.focus();
          text.inputEl.select();
        }, 20);
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('Save')
          .setCta()
          .onClick(() => this.submit(newName))
      )
      .addButton((btn) =>
        btn.setButtonText('Cancel').onClick(() => this.close())
      );
  }

  private submit(name: string) {
    if (this.submitted) return;
    const trimmed = name.trim();
    if (!trimmed) {
      new Notice('Tab name cannot be empty.');
      return;
    }
    if (trimmed === this.currentName.trim()) {
      this.close();
      return;
    }
    this.submitted = true;
    this.onRename(trimmed);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

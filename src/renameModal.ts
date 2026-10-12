import { App, Modal, Setting } from 'obsidian';

export class RenameTabModal extends Modal {
  private currentName: string;
  private onRename: (newName: string) => void;

  constructor(app: App, currentName: string, onRename: (newName: string) => void) {
    super(app);
    this.currentName = currentName;
    this.onRename = onRename;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Rename Tab' });

    let newName = this.currentName;

    new Setting(contentEl)
      .setName('Tab name')
      .addText((text) => {
        text.setValue(this.currentName).onChange((val) => {
          newName = val;
        });
        text.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.submit(newName);
          }
        });
        setTimeout(() => text.inputEl.focus(), 20);
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
    const trimmed = name.trim();
    if (trimmed) {
      this.onRename(trimmed);
    }
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

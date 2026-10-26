import { App, FuzzySuggestModal } from 'obsidian';
import { Conversation, compareConversationsByStatus } from './resolver';
import { HARNESS_KINDS } from './herdrClient';

export interface ActionItem {
  id: string;
  type: 'conversation' | 'close_conversation';
  title: string;
  description: string;
  conv?: Conversation;
}

export class HerdrSwitcherModal extends FuzzySuggestModal<ActionItem> {
  private items: ActionItem[] = [];
  private onSelectAction: (item: ActionItem) => void;

  constructor(
    app: App,
    convs: Conversation[],
    onSelectAction: (item: ActionItem) => void,
    mode: 'switch' | 'close' = 'switch'
  ) {
    super(app);
    this.onSelectAction = onSelectAction;
    this.setPlaceholder(mode === 'close' ? 'Select a tab to close...' : 'Switch terminal tab...');

    if (mode === 'close') {
      this.items = convs.map((c) => {
        return {
          id: c.tab_id,
          type: 'close_conversation',
          title: `Close ${c.label}`,
          description: `${c.agent && c.agent !== c.label ? c.agent + ' • ' : ''}${c.status}${c.status === 'blocked' ? ' — waiting for input' : ''}`,
          conv: c
        };
      });
      return;
    }

    const sorted = [...convs].sort(compareConversationsByStatus);

    for (const c of sorted) {
      this.items.push({
        id: c.tab_id,
        type: 'conversation',
        title: c.label,
        description: `${c.agent && c.agent !== c.label ? c.agent + ' • ' : ''}${c.status.toUpperCase()}${c.status === 'blocked' ? ' — waiting for input' : ''}`,
        conv: c
      });
    }
  }

  getItems(): ActionItem[] {
    return this.items;
  }

  getItemText(item: ActionItem): string {
    return `${item.title} — ${item.description}`;
  }

  onChooseItem(item: ActionItem, _evt: MouseEvent | KeyboardEvent): void {
    this.onSelectAction(item);
  }
}

export class HarnessPickerModal extends FuzzySuggestModal<string> {
  private onPick: (kind: string) => void;

  constructor(app: App, onPick: (kind: string) => void) {
    super(app);
    this.onPick = onPick;
    this.setPlaceholder('Select the agent to start');
  }

  getItems(): string[] {
    return [...HARNESS_KINDS];
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string, _evt: MouseEvent | KeyboardEvent): void {
    this.onPick(item);
  }
}

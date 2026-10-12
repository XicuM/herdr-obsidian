import { App, FuzzySuggestModal } from 'obsidian';
import { Conversation } from './resolver';
import { statusEmoji } from './notifier';
import { HARNESS_KINDS } from './herdrClient';

export interface ActionItem {
  id: string;
  type: 'conversation' | 'new_conversation' | 'new_shell' | 'refresh' | 'close_conversation';
  title: string;
  description: string;
  conv?: Conversation;
  harnessKind?: string;
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
    this.setPlaceholder(mode === 'close' ? 'Select a conversation tab to close...' : 'Switch Herdr agent tab or action...');

    if (mode === 'close') {
      this.items = convs.map((c) => {
        const emoji = statusEmoji(c.status);
        const prefix = emoji ? `${emoji} ` : '';
        const shortTab = c.tab_id.includes(':t') ? c.tab_id.replace(/^.*:t/, 't') : c.tab_id;
        return {
          id: c.tab_id,
          type: 'close_conversation',
          title: `Close: ${prefix}${c.label}`,
          description: `Tab ${shortTab} (${c.status})`,
          conv: c
        };
      });
      return;
    }

    const statusPriority: Record<string, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
    const sorted = [...convs].sort((a, b) => {
      const prioDiff = (statusPriority[a.status] ?? 5) - (statusPriority[b.status] ?? 5);
      if (prioDiff !== 0) return prioDiff;
      return a.label.localeCompare(b.label);
    });

    for (const c of sorted) {
      const emoji = statusEmoji(c.status);
      const prefix = emoji ? `${emoji} ` : '';
      const shortTab = c.tab_id.includes(':t') ? c.tab_id.replace(/^.*:t/, 't') : c.tab_id;
      this.items.push({
        id: c.tab_id,
        type: 'conversation',
        title: `${prefix}${c.label}`,
        description: `Tab ${shortTab} • [${c.status.toUpperCase()}]${c.status === 'blocked' ? ' (Waiting for input!)' : ''}`,
        conv: c
      });
    }

    this.items.push(
      {
        id: '__shell__',
        type: 'new_shell',
        title: '💻 New Shell Tab',
        description: 'Open a plain shell tab in this vault workspace'
      },
      {
        id: '__new__',
        type: 'new_conversation',
        title: '➕ New Agent Conversation...',
        description: 'Start an AI coding agent in a new tab'
      },
      {
        id: '__refresh__',
        type: 'refresh',
        title: '🔄 Refresh Herdr Status',
        description: 'Query Herdr daemon for latest state'
      }
    );
  }

  getItems(): ActionItem[] {
    return this.items;
  }

  getItemText(item: ActionItem): string {
    return `${item.title} ${item.description}`;
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
    this.setPlaceholder('Select agent harness (claude, codex, opencode, ...):');
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

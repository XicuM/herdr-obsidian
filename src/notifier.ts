import { Notice } from 'obsidian';
import { AgentStatus } from './herdrClient';
import { Conversation } from './resolver';

export function statusEmoji(status: AgentStatus): string {
  switch (status) {
    case 'working':
      return '🟡';
    case 'blocked':
      return '🔴';
    case 'done':
      return '🟢';
    case 'idle':
      return '⚪';
    case 'unknown':
    default:
      return '';
  }
}

export class AgentAttender {
  private last = new Map<string, AgentStatus>();
  private convByPane = new Map<string, Conversation>();
  private onFocus?: (conv: Conversation) => void;

  constructor(private cfg: { focusOnBlocked: boolean }) {}

  updateConfig(cfg: { focusOnBlocked: boolean }) {
    this.cfg = cfg;
  }

  setOnFocus(fn: (conv: Conversation) => void) {
    this.onFocus = fn;
  }

  setConversations(convs: Conversation[]) {
    this.convByPane.clear();
    for (const c of convs) this.convByPane.set(c.pane_id, c);
  }

  handleStatusChange(paneId: string, status: AgentStatus) {
    const prev = this.last.get(paneId);
    if (prev === status) return;
    this.last.set(paneId, status);

    if (status === 'blocked' && this.cfg.focusOnBlocked) {
      this.focusConversation(paneId);
    }
  }

  private focusConversation(paneId: string) {
    const conv = this.convByPane.get(paneId);
    if (!conv) return;
    if (this.onFocus) {
      this.onFocus(conv);
    }
    const emoji = statusEmoji(conv.status);
    const emojiStr = emoji ? ` (${emoji})` : '';
    new Notice(`Herdr: ${conv.label}${emojiStr} is blocked and waiting for your input!`, 8000);
  }
}

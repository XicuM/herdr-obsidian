import { Notice } from 'obsidian';
import { AgentStatus } from './herdrClient';
import { Conversation } from './resolver';

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
    // First sighting: record baseline, never notify (prevents startup spam).
    if (prev === undefined) {
      this.last.set(paneId, status);
      return;
    }
    if (prev === status) return;
    this.last.set(paneId, status);

    // Only notify on transition INTO blocked (working/idle/done/unknown -> blocked).
    if (status === 'blocked' && prev !== 'blocked' && this.cfg.focusOnBlocked) {
      this.focusConversation(paneId);
    }
  }

  private focusConversation(paneId: string) {
    const conv = this.convByPane.get(paneId);
    if (!conv) return;
    if (this.onFocus) {
      this.onFocus(conv);
    }
    new Notice(`Herdr: ${conv.label} is blocked and waiting for input!`, 8000);
  }
}

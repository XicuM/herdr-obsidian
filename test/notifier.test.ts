import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notices } from 'obsidian';
import { AgentAttender } from '../src/notifier';
import { Conversation } from '../src/resolver';

const conv = { tab_id: 't1', pane_id: 'p1', label: 'claude' } as Conversation;

describe('AgentAttender', () => {
  beforeEach(() => {
    notices.length = 0;
  });

  const setup = (focusOnBlocked = true) => {
    const a = new AgentAttender({ focusOnBlocked });
    const onFocus = vi.fn();
    a.setOnFocus(onFocus);
    a.setConversations([conv]);
    return { a, onFocus };
  };

  it('does not notify on the first sighting, even if blocked', () => {
    const { a, onFocus } = setup();
    a.handleStatusChange('p1', 'blocked');
    expect(onFocus).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it('focuses and notifies on a transition into blocked, once', () => {
    const { a, onFocus } = setup();
    a.handleStatusChange('p1', 'working');
    a.handleStatusChange('p1', 'blocked');
    a.handleStatusChange('p1', 'blocked');
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith(conv);
    expect(notices).toEqual(['Herdr: claude is blocked and waiting for input!']);
  });

  it('ignores transitions to other states', () => {
    const { a, onFocus } = setup();
    a.handleStatusChange('p1', 'working');
    a.handleStatusChange('p1', 'done');
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('reads focusOnBlocked live from the settings object it shares', () => {
    const settings = { focusOnBlocked: false };
    const a = new AgentAttender(settings);
    const onFocus = vi.fn();
    a.setOnFocus(onFocus);
    a.setConversations([conv]);
    a.handleStatusChange('p1', 'working');
    a.handleStatusChange('p1', 'blocked');
    expect(onFocus).not.toHaveBeenCalled();
    settings.focusOnBlocked = true;
    a.handleStatusChange('p1', 'working');
    a.handleStatusChange('p1', 'blocked');
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('stays silent for panes without a known conversation', () => {
    const { a, onFocus } = setup();
    a.handleStatusChange('p2', 'idle');
    a.handleStatusChange('p2', 'blocked');
    expect(onFocus).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });
});

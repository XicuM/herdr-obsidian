// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { getTerminalTheme } from '../src/terminalTheme';

const css = (vars: Record<string, string>) => {
  for (const [k, v] of Object.entries(vars)) document.body.style.setProperty(k, v);
};

beforeEach(() => {
  document.body.removeAttribute('style');
  document.body.className = '';
});

describe('getTerminalTheme', () => {
  it('forced dark/light ignore the Obsidian theme colours', () => {
    css({ '--background-primary': '#123456', '--text-normal': '#abcdef' });
    expect(getTerminalTheme('dark')).toMatchObject({ background: '#1e1e1e', foreground: '#cccccc', cursor: '#aeafad' });
    expect(getTerminalTheme('light')).toMatchObject({ background: '#ffffff', foreground: '#1f2328', cursor: '#000000' });
  });

  it('auto follows Obsidian CSS variables', () => {
    css({ '--background-primary': '#123456', '--text-normal': 'rgb(1, 2, 3)', '--text-accent': '#ff0000', '--text-selection': 'rgba(0,0,0,.3)' });
    expect(getTerminalTheme('auto')).toMatchObject({
      background: '#123456',
      foreground: 'rgb(1, 2, 3)',
      cursor: '#ff0000',
      selectionBackground: 'rgba(0,0,0,.3)'
    });
  });

  it('auto picks light fallbacks under .theme-light', () => {
    document.body.classList.add('theme-light');
    expect(getTerminalTheme('auto')).toMatchObject({ background: '#ffffff', foreground: '#1f2328', selectionBackground: 'rgba(0, 0, 0, 0.2)' });
  });

  it.each([
    ['transparent'],
    ['#12345680'],
    ['rgba(0, 0, 0, 0.5)'],
    ['rgb(var(--x))'],
    ['hsla(0, 0%, 0%, 50%)'],
    ['rebeccapurple']
  ])('auto rejects the translucent or unresolvable background %s', (bg) => {
    css({ '--background-primary': bg });
    expect(getTerminalTheme('auto').background).toBe('#1e1e1e');
  });

  it.each([['#abc'], ['#aabbccff'], ['rgba(1, 2, 3, 1)'], ['hsl(10, 20%, 30%)'], ['black']])('auto accepts the opaque background %s', (bg) => {
    css({ '--background-primary': bg });
    expect(getTerminalTheme('auto').background).toBe(bg);
  });
});

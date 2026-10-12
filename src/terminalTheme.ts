export interface TerminalThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export function getTerminalTheme(mode: 'auto' | 'dark' | 'light'): TerminalThemeColors {
  const isLight = mode === 'light' || (mode === 'auto' && document.body.classList.contains('theme-light'));

  if (isLight) {
    return {
      background: '#ffffff',
      foreground: '#2e3338',
      cursor: '#2e3338',
      selectionBackground: 'rgba(0, 100, 200, 0.25)',
      black: '#2e3338',
      red: '#d73a49',
      green: '#22863a',
      yellow: '#b08800',
      blue: '#0366d6',
      magenta: '#6f42c1',
      cyan: '#005cc5',
      white: '#fafbfc',
      brightBlack: '#6a737d',
      brightRed: '#cb2431',
      brightGreen: '#28a745',
      brightYellow: '#dbab09',
      brightBlue: '#2188ff',
      brightMagenta: '#8a63d2',
      brightCyan: '#3192aa',
      brightWhite: '#ffffff'
    };
  }

  return {
    background: '#141414',
    foreground: '#dcddde',
    cursor: '#dcddde',
    selectionBackground: 'rgba(255, 255, 255, 0.25)',
    black: '#1e1e1e',
    red: '#f85149',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ff7b72',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc'
  };
}

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

function resolveCssColor(varName: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const computed = getComputedStyle(document.body).getPropertyValue(varName).trim();
  if (computed) return computed;
  return fallback;
}

function isUsableOpaqueColor(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (!c || c === 'transparent' || c === 'inherit' || c === 'initial') return false;
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/.test(c)) {
    // #rgb, #rrggbb, #rrggbbaa — reject if alpha channel present and < ff.
    if (c.length === 9 && c.slice(7) !== 'ff') return false;
    return true;
  }
  let m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(',').map((p) => p.trim());
    // Bare triplets ("255, 255, 255") and var()/calc() refs are unusable.
    if (parts.some((p) => /var\(|calc\(|[^0-9.\s%/]/.test(p))) return false;
    if (parts.length === 4) {
      const alpha = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      if (isNaN(alpha) || alpha < 1) return false;
    }
    return parts.length === 3 || parts.length === 4;
  }
  m = c.match(/^hsla?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(',').map((p) => p.trim());
    if (parts.some((p) => /var\(|calc\(/.test(p))) return false;
    if (parts.length === 4) {
      const alpha = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      if (isNaN(alpha) || alpha < 1) return false;
    }
    return true;
  }
  // Named colors: accept common opaque ones, reject everything else.
  return /^(white|black|red|green|blue|yellow|ivory|snow|ghostwhite|floralwhite|whitesmoke|beige|lightgray|darkgray|gray|dimgray|black)$/.test(c);
}

function resolveOpaqueColor(varName: string, fallback: string): string {
  const resolved = resolveCssColor(varName, fallback);
  if (!isUsableOpaqueColor(resolved)) return fallback;
  return resolved;
}
function resolveCursorColor(isLight: boolean): string {
  const accent = resolveCssColor('--text-accent', '');
  if (accent && isUsableOpaqueColor(accent)) return accent;
  return isLight ? '#000000' : '#aeafad';
}

function resolveSelectionColor(isLight: boolean): string {
  const highlight = resolveCssColor('--text-selection', '');
  if (highlight) return highlight;
  return isLight ? 'rgba(0, 0, 0, 0.2)' : 'rgba(174, 175, 173, 0.4)';
}

export function getTerminalTheme(mode: 'auto' | 'dark' | 'light'): TerminalThemeColors {
  const isLight = mode === 'light' || (mode === 'auto' && typeof document !== 'undefined' && document.body.classList.contains('theme-light'));

  const bgFallback = isLight ? '#ffffff' : '#1e1e1e';
  const fgFallback = isLight ? '#1f2328' : '#cccccc';

  const background = mode === 'dark' ? '#1e1e1e' : mode === 'light' ? '#ffffff' : resolveOpaqueColor('--background-primary', bgFallback);
  const foreground = mode === 'dark' ? '#cccccc' : mode === 'light' ? '#1f2328' : resolveOpaqueColor('--text-normal', fgFallback);

  return {
    background,
    foreground,
    cursor: resolveCursorColor(isLight),
    selectionBackground: resolveSelectionColor(isLight),
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff'
  };
}

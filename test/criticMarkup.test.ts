import { describe, expect, it } from 'vitest';
import { changeAt, resolveAll } from '../src/criticMarkup';

const text = 'a {++new++} b {--old--} c {~~x~>y~~} d {==hi==}{>>why<<}';

describe('criticMarkup', () => {
  it('accepts every kind', () => {
    expect(resolveAll(text, true)).toBe('a new b  c y d hi');
  });

  it('rejects every kind', () => {
    expect(resolveAll(text, false)).toBe('a  b old c x d hi');
  });

  it('finds the change at an offset', () => {
    const change = changeAt(text, text.indexOf('old'))!;
    expect(text.slice(change.from, change.to)).toBe('{--old--}');
    expect(change.replacement(false)).toBe('old');
    expect(changeAt(text, 1)).toBeNull();
  });
});

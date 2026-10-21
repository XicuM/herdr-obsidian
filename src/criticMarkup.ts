import { editorLivePreviewField } from 'obsidian';
import { RangeSet } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

/** CriticMarkup: {++added++} {--deleted--} {~~old~>new~~} {>>comment<<} {==highlight==}. */
const CRITIC = /\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{~~([\s\S]*?)~>([\s\S]*?)~~\}|\{>>([\s\S]*?)<<\}|\{==([\s\S]*?)==\}/g;

/** The text a change leaves behind once accepted or rejected. */
export function resolve(m: RegExpMatchArray, accept: boolean): string {
  const [, add, del, old, neu, comment, mark] = m;
  if (add !== undefined) return accept ? add : '';
  if (del !== undefined) return accept ? '' : del;
  if (old !== undefined) return accept ? neu : old;
  return comment !== undefined ? '' : mark;
}

export function resolveAll(text: string, accept: boolean): string {
  return text.replace(CRITIC, (...args) => resolve(args, accept));
}

/** The change containing `offset` in `text`, with its span. */
export function changeAt(text: string, offset: number): { from: number; to: number; replacement: (accept: boolean) => string } | null {
  for (const m of text.matchAll(CRITIC)) {
    const from = m.index;
    const to = from + m[0].length;
    if (from <= offset && offset <= to) return { from, to, replacement: (accept) => resolve(m, accept) };
  }
  return null;
}

/** Live Preview: hides the markers and colours the text, except where the cursor is, so it stays editable. */
export const criticMarkupEditor = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations }
);

function build(view: EditorView): DecorationSet {
  // Source mode shows the raw markup.
  if (!view.state.field(editorLivePreviewField)) return Decoration.none;
  const hide = Decoration.replace({});
  const ranges = [];
  for (const { from: start, to: end } of view.visibleRanges) {
    for (const m of view.state.doc.sliceString(start, end).matchAll(CRITIC)) {
      const from = start + m.index;
      const to = from + m[0].length;
      if (view.state.selection.ranges.some((r) => r.from <= to && r.to >= from)) continue;
      const [, add, del, old, neu, comment] = m;
      // Each piece: [text, class]; markers are 3 characters either side, and `~>` between a substitution's halves.
      const pieces: [string, string][] =
        add !== undefined ? [[add, 'add']] :
        del !== undefined ? [[del, 'del']] :
        old !== undefined ? [[old, 'del'], ['~>', ''], [neu, 'add']] :
        comment !== undefined ? [[comment, 'comment']] : [[m[6], 'mark']];
      let at = from;
      ranges.push(hide.range(at, at + 3));
      at += 3;
      for (const [text, cls] of pieces) {
        if (!cls) ranges.push(hide.range(at, at + text.length));
        else if (text) ranges.push(Decoration.mark({ class: `herdr-critic-${cls}` }).range(at, at + text.length));
        at += text.length;
      }
      ranges.push(hide.range(at, to));
    }
  }
  return RangeSet.of(ranges, true);
}

/**
 * Reading view. Obsidian has already turned `~~` and `==` into <del> and <mark>, so a substitution
 * or highlight arrives as `{` <del>old~>new</del> `}`; the rest is still plain text.
 */
export function renderCriticMarkup(el: HTMLElement) {
  const texts: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const node of texts) {
    if (!node.data.includes('{') || node.parentElement?.closest('code, pre')) continue;
    const parts: (string | HTMLElement)[] = [];
    let last = 0;
    for (const m of node.data.matchAll(CRITIC)) {
      const [, add, del, old, , comment] = m;
      if (old !== undefined) continue;
      parts.push(node.data.slice(last, m.index));
      parts.push(span(add !== undefined ? 'add' : del !== undefined ? 'del' : comment !== undefined ? 'comment' : 'mark', m[1] ?? m[2] ?? m[5] ?? m[6]));
      last = m.index + m[0].length;
    }
    if (last) node.replaceWith(...parts, node.data.slice(last));
  }

  for (const tag of Array.from(el.querySelectorAll('del, mark'))) {
    const before = tag.previousSibling;
    const after = tag.nextSibling;
    if (before?.nodeType !== Node.TEXT_NODE || after?.nodeType !== Node.TEXT_NODE) continue;
    if (!before.nodeValue?.endsWith('{') || !after.nodeValue?.startsWith('}')) continue;
    const [old, neu] = (tag.textContent ?? '').split('~>');
    const isSubstitution = tag.tagName === 'DEL' && neu !== undefined;
    if (tag.tagName === 'DEL' && !isSubstitution) continue;
    before.nodeValue = before.nodeValue.slice(0, -1);
    after.nodeValue = after.nodeValue.slice(1);
    tag.replaceWith(...(isSubstitution ? [span('del', old), span('add', neu)] : [span('mark', old)]));
  }
}

function span(kind: string, text: string): HTMLElement {
  return createSpan({ cls: `herdr-critic-${kind}`, text });
}

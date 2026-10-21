// @vitest-environment jsdom
import * as directState from '@codemirror/state';
import * as directView from '@codemirror/view';
import type { DecorationSet, EditorView as View, ViewUpdate } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { codemirror } from './codemirror-entry';
import { loadPage, until } from './fake-file-service';

/**
 * 摩擦单 F25: `gugu.codemirror()` hands out the platform's CodeMirror modules whole — an App draws `**x**` bold with its
 * own Decoration and ViewPlugin, on the editor the platform binds to a shared file. They must be the very copies the
 * binding uses: a second @codemirror/state would make the App's fields and facets strangers to the bound editor.
 */

type TextFile = { text: string; insert(index: number, text: string): void; close(): void };

afterEach(() => {
  document.body.replaceChildren();
});

describe('gugu.codemirror(): the modules whole, one copy (F25)', () => {
  it('each namespace is the one module the binding and the shortcuts come from', () => {
    expect(codemirror.view).toBe(directView);
    expect(codemirror.state).toBe(directState);
    expect(codemirror.view.EditorView).toBe(codemirror.EditorView);
    expect(codemirror.state.EditorState).toBe(codemirror.EditorState);
    expect(codemirror.view.keymap).toBe(codemirror.keymap);
    expect(codemirror.langMarkdown.markdown).toBe(codemirror.markdown);
    expect(codemirror.langMarkdown.markdownLanguage).toBe(codemirror.markdownLanguage);
    expect(codemirror.langJson.json).toBe(codemirror.json);
    for (const name of ['language', 'commands', 'search', 'autocomplete', 'lint', 'lezerCommon', 'lezerHighlight', 'lezerMarkdown'] as const) {
      expect(Object.keys(codemirror[name]).length, name).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(codemirror)).toBe(true);
    // Highlighting by syntax, as the guide says (L3's review): the pieces are there, and they build an extension.
    const style = codemirror.language.HighlightStyle.define([{ tag: codemirror.lezerHighlight.tags.strong, fontWeight: 'bold' }]);
    expect(codemirror.language.syntaxHighlighting(style)).toBeTruthy();
  });

  it('an App\'s own Decoration and ViewPlugin draw **x** bold on the editor bound to a shared file, as others type', async () => {
    const { open } = await loadPage<TextFile>('text');
    // The page's runtime as loadPage made it (modules reset): its binding knows the files it opened.
    const { codemirror: cm, bindCodemirror } = await import('./codemirror-entry');
    const file = await open();
    file.insert(0, 'plan: **ship** today');
    const { EditorView, ViewPlugin, Decoration, MatchDecorator } = cm.view;
    const bold = new MatchDecorator({ regexp: /\*\*[^*\n]+\*\*/g, decoration: Decoration.mark({ class: 'app-bold' }) });
    const boldPlugin = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: View) {
          this.decorations = bold.createDeco(view);
        }
        update(update: ViewUpdate) {
          this.decorations = bold.updateDeco(update, this.decorations);
        }
      },
      { decorations: (plugin) => plugin.decorations }
    );
    const view = new EditorView({ parent: document.body, extensions: [cm.minimalSetup, cm.markdown(), boldPlugin] });
    const unbind = bindCodemirror(view, file);
    const marked = () => [...view.contentDOM.querySelectorAll('.app-bold')].map((element) => element.textContent);
    await until(() => view.state.doc.toString() === 'plan: **ship** today');
    expect(marked()).toEqual(['**ship**']);
    // A change that does not come from this editor (as another person's or an agent's arrives): the decoration follows.
    file.insert(file.text.length, ' and **test**');
    await until(() => marked().length === 2);
    expect(marked()).toEqual(['**ship**', '**test**']);
    unbind();
    view.destroy();
    file.close();
  });
});

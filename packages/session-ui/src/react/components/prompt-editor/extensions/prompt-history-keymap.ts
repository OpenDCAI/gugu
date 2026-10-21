/**
 * behavior session-page「键盘导航」: ↑↓ in the composer walk this session's already-sent prompts.
 *
 * This is what makes ↑↓ "have something to do" in the composer, which is in turn why they never
 * switch sessions — the session list is reached with ←. The two rules are one design, not two.
 *
 * Line-awareness rather than emptiness: ↑ only recalls from the first line and ↓ only from the
 * last, so a multi-line draft still moves the caret between its own lines. A non-empty selection
 * always belongs to the caret.
 */

import { Extension } from '@tiptap/core';
import type { Editor, JSONContent } from '@tiptap/core';
import { plainTextDoc, serializeDoc } from '../serialize';

/** How far back the box currently is. `index === -1` means it is showing the user's own draft. */
export interface PromptHistoryBrowse {
  index: number;
  /** The draft stashed on entry, put back on the way out. */
  draft: string;
}

export const NOT_BROWSING: PromptHistoryBrowse = { index: -1, draft: '' };

export interface PromptHistoryStep {
  browse: PromptHistoryBrowse;
  /** New box contents, or null to consume the key while leaving the box as it is. */
  text: string | null;
  /**
   * True when `text` is the user's own stashed draft rather than a history entry. The glue puts
   * the draft back from a stored document instead of re-parsing this string: a draft can hold
   * mention pills, and text → doc → text would hand them back as raw `@[a](b)` markup.
   */
  restoresDraft?: boolean;
}

/**
 * The whole walk, as a pure function: where the box goes for one ↑ or ↓.
 *
 * Returning `null` means "not ours" — the caret gets the key. That is the only way ↓ can stay a
 * normal caret move while the user is not browsing.
 */
export function stepPromptHistory(
  direction: 'older' | 'newer',
  browse: PromptHistoryBrowse,
  history: readonly string[],
  currentText: string
): PromptHistoryStep | null {
  if (direction === 'older') {
    if (history.length === 0) return null;
    if (browse.index === -1) {
      const index = history.length - 1;
      return { browse: { index, draft: currentText }, text: history[index] };
    }
    // Already at the oldest prompt: consume rather than let the caret jump out of recalled text,
    // which reads as the box losing your place.
    if (browse.index === 0) return { browse, text: null };
    const index = browse.index - 1;
    return { browse: { ...browse, index }, text: history[index] };
  }

  if (browse.index === -1) return null;
  const index = browse.index + 1;
  // Walked back past the newest prompt — the user's own draft is what comes after it.
  if (index >= history.length) return { browse: NOT_BROWSING, text: browse.draft, restoresDraft: true };
  return { browse: { ...browse, index }, text: history[index] };
}

export interface PromptHistoryKeymapDeps {
  /** This session's sent prompts, oldest first. Read on each keypress, never cached. */
  getHistory: () => readonly string[];
}

/**
 * Is the caret on the document's first (or last) line, the way the user sees lines?
 *
 * `endOfTextblock` asks the browser whether a vertical caret move would leave this block, so it
 * accounts for **soft wrapping** — a long single-paragraph draft really does have a second visual
 * line. Counting '\n' in the serialized text cannot: a wrapped line has no newline in it (↑ would
 * eat the draft mid-edit), and `textBetween`'s leafText applies to every leaf, so a mention pill
 * reads as a newline (↑ would go dead in any draft with an @mention).
 */
function atEdgeLine(editor: Editor, direction: 'up' | 'down'): boolean {
  const { state, view } = editor;
  const { $from } = state.selection;
  if (!view.endOfTextblock(direction)) return false;
  // …and the block itself has to be the first/last one, or ↑ would recall from the middle of a
  // multi-paragraph draft instead of moving between its paragraphs.
  const depth = $from.depth;
  return direction === 'up'
    ? $from.before(depth) === 0
    : $from.after(depth) === state.doc.content.size;
}

export function buildPromptHistoryKeymap({ getHistory }: PromptHistoryKeymapDeps) {
  let browse: PromptHistoryBrowse = NOT_BROWSING;
  /** The draft's own document, kept so pills survive the round trip (see `restoresDraft`). */
  let stashedDoc: JSONContent | null = null;
  /** Set while this extension is the one writing, so its own writes do not read as "user typed". */
  let applying = false;

  const apply = (editor: Editor, step: PromptHistoryStep): boolean => {
    const wasBrowsing = browse.index !== -1;
    browse = step.browse;
    if (step.text === null) return true;
    // History entries are plain text (they come from the transcript); the draft goes back as the
    // document it was.
    const content: JSONContent =
      step.restoresDraft && stashedDoc ? stashedDoc : plainTextDoc(step.text);
    if (!wasBrowsing) stashedDoc = editor.getJSON();
    applying = true;
    try {
      // Caret to the end: recalling a prompt is almost always a prelude to editing its tail.
      editor.chain().setContent(content, { emitUpdate: true }).focus('end').run();
    } finally {
      // Without the finally a single throw would wedge `applying` on, and from then on every user
      // edit would read as this extension's own write — the walk would never reset again.
      applying = false;
    }
    return true;
  };

  return Extension.create({
    name: 'promptHistoryKeymap',
    // Below the suggestion plugins on purpose: while a mention or slash popup is open the arrows
    // are its, and TipTap resolves that by priority (higher wins), not by array order.
    priority: 90,

    // Any edit the user makes ends the browse — the next ↑ starts again from the newest prompt
    // rather than from wherever the previous walk happened to stop.
    onUpdate() {
      if (applying) return;
      browse = NOT_BROWSING;
      stashedDoc = null;
    },

    addKeyboardShortcuts() {
      return {
        ArrowUp: ({ editor }) => {
          if (!editor.state.selection.empty) return false;
          if (!atEdgeLine(editor, 'up')) return false;
          const step = stepPromptHistory(
            'older',
            browse,
            getHistory(),
            serializeDoc(editor.state.doc)
          );
          return step ? apply(editor, step) : false;
        },

        ArrowDown: ({ editor }) => {
          if (!editor.state.selection.empty) return false;
          if (!atEdgeLine(editor, 'down')) return false;
          const step = stepPromptHistory(
            'newer',
            browse,
            getHistory(),
            serializeDoc(editor.state.doc)
          );
          return step ? apply(editor, step) : false;
        },
      };
    },
  });
}

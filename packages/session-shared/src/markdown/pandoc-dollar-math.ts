/**
 * Single-dollar text math, recognised the way pandoc's `tex_math_dollars` does: the opening `$` must have a
 * non-space character right after it, the closing `$` a non-space character right before it and no digit right
 * after it. Without this, prose with two prices ("Backpack $29.99、Bike Light $9.99") became one inline formula.
 *
 * One rule goes beyond pandoc: the closing `$` also cannot be followed by what starts a shell expansion (an ASCII
 * letter, `_`, `(` or `{`), so `$(seq 1 40); echo live-$i` and `$HOME/$USER` stay text. `\(n\)th` still reads as math.
 *
 * `remark-math` has no such option (upstream declined it: micromark/micromark-extension-math#6), so this is a guard
 * in front of its text construct. At a single `$` it looks ahead to the closing `$` that `remark-math` would pick (the
 * next run of exactly one `$`); if either end breaks the rules the `$` is plain text, otherwise `remark-math` parses
 * it as before. Runs of two or more dollars are left to `remark-math` untouched.
 *
 * `tokenizeMarkdownMath` (@gugu/core/shared/markdownMath.mjs) applies the same rules, so what message_send checks
 * as math is what renders as math.
 */
import { asciiAlphanumeric, markdownLineEndingOrSpace, unicodeWhitespace } from 'micromark-util-character';
import type { Code, Construct, Extension, State, TokenizeContext, Tokenizer } from 'micromark-util-types';
import type { Processor } from 'unified';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    /** The look-ahead over a would-be single-dollar math span (never kept: it runs inside `check`). */
    pandocDollarProbe: 'pandocDollarProbe';
  }
}

const DOLLAR = 36;
const LEFT_PAREN = 40;
const UNDERSCORE = 95;
const LEFT_BRACE = 123;

function blank(code: Code): boolean {
  return code === null || markdownLineEndingOrSpace(code) || unicodeWhitespace(code);
}

/** A digit (a price) or the start of a shell expansion: what a closing `$` cannot have right after it. */
function continuesPastClose(code: Code): boolean {
  return asciiAlphanumeric(code) || code === UNDERSCORE || code === LEFT_PAREN || code === LEFT_BRACE;
}

/** Succeeds when the `$` here is not a single-dollar math opener that pandoc would reject. */
const deferToMath: Construct = { tokenize: tokenizeDeferToMath, partial: true };

function tokenizeDeferToMath(this: TokenizeContext, effects: Parameters<Tokenizer>[0], ok: State, nok: State): State {
  let opening = 0;
  let closing = 0;
  let before: Code = null;
  return start;

  // A lookahead (`check`): what it consumes is given back either way, but consuming needs an open token.
  function start(code: Code): State | undefined {
    effects.enter('pandocDollarProbe');
    return openSequence(code);
  }

  function done(code: Code, valid: boolean): State | undefined {
    effects.exit('pandocDollarProbe');
    return valid ? ok(code) : nok(code);
  }

  function openSequence(code: Code): State | undefined {
    if (code === DOLLAR) {
      effects.consume(code);
      opening += 1;
      return openSequence;
    }
    // Two or more dollars: not ours to judge.
    if (opening !== 1) return done(code, true);
    return blank(code) ? done(code, false) : inside(code);
  }

  function inside(code: Code): State | undefined {
    if (code === null) return done(code, false);
    if (code === DOLLAR) {
      closing = 0;
      return closeSequence(code);
    }
    before = code;
    effects.consume(code);
    return inside;
  }

  function closeSequence(code: Code): State | undefined {
    if (code === DOLLAR) {
      effects.consume(code);
      closing += 1;
      return closeSequence;
    }
    // A run of another length is content to remark-math too; keep looking.
    if (closing !== 1) {
      before = DOLLAR;
      return inside(code);
    }
    return done(code, !blank(before) && !continuesPastClose(code));
  }
}

const singleDollarGuard: Construct = {
  name: 'pandocSingleDollarGuard',
  add: 'before',
  // Same place remark-math's text math may start: not right after another `$`, unless that one was escaped.
  previous(code) {
    return code !== DOLLAR || this.events[this.events.length - 1]?.[1].type === 'characterEscape';
  },
  tokenize(effects, ok, nok) {
    return start;

    function start(code: Code): State | undefined {
      return effects.check(deferToMath, nok, literal)(code);
    }

    function literal(code: Code): State | undefined {
      effects.enter('data');
      effects.consume(code);
      effects.exit('data');
      return ok;
    }
  },
};

const extension: Extension = { text: { [DOLLAR]: singleDollarGuard } };

/** Plugin: register the guard; put it after `remark-math`. */
export function remarkPandocDollarMath(this: Processor): void {
  const data = this.data() as { micromarkExtensions?: Extension[] };
  (data.micromarkExtensions ??= []).push(extension);
}

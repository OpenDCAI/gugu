/**
 * Canonical mention grammar shared between the chat composer (write path) and
 * the transcript parser (read path) so neither side can drift from the other.
 *
 * Pure TypeScript — no remark/unified dependencies.
 */

/** Discriminator for the three inline-chip syntax forms. */
export type MentionSyntax = 'at-bare' | 'at-bracket' | 'slash';

/** Semantic category for a mention, mirrors the composer's MentionKind. */
export type MentionKind = 'file' | 'issue' | 'symbol' | 'custom';

/**
 * Pattern source for bare @-mention tokens.
 *
 * Matches word chars, slashes, hyphens, colons, parens, and internal dots.
 * A trailing dot is NOT consumed (sentence-final dot avoidance).
 *
 * Examples matched: @src/auth/jwt.ts  @issue-42  @handleSubmit()  @.gitignore
 *
 * Use as: `new RegExp(AT_BARE_PATTERN, 'g')`
 */
export const AT_BARE_PATTERN = String.raw`@((?:[\w/\-:()]|\.(?=[\w/\-:()]))+)`;

/**
 * Pattern source for /-command tokens.
 *
 * Matches only at line start or after whitespace to avoid matching path
 * separators and URLs (e.g. path/to/file, https://example.com/path).
 *
 * Examples matched: /web  /search-files  /explain
 *
 * Use as: `new RegExp(SLASH_PATTERN, 'g')`
 */
export const SLASH_PATTERN = String.raw`(?:^|(?<=\s))\/([\w-]+)`;

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Make the common agent form `[label](C:\\path with spaces\\file)` valid
 * CommonMark without changing links that are already valid. Bare destinations
 * cannot contain spaces, so remark otherwise leaves this Windows file link as
 * ordinary text and the chat renderer never gets an href to classify.
 */
export function normalizeWindowsMarkdownFileLinks(markdown: string): string {
  let fence: { char: '`' | '~'; length: number } | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const fenceMatch = /^ {0,3}([`~]{3,})/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1]!;
        const markerChar = marker[0] as '`' | '~';
        if (!fence) {
          fence = { char: markerChar, length: marker.length };
        } else if (fence.char === markerChar && marker.length >= fence.length) {
          fence = null;
        }
        return line;
      }
      return fence ? line : normalizeWindowsLinksInLine(line);
    })
    .join('\n');
}

function normalizeWindowsLinksInLine(line: string): string {
  let out = '';
  let cursor = 0;
  let codeDelimiter: string | null = null;

  while (cursor < line.length) {
    if (line[cursor] === '`') {
      let end = cursor + 1;
      while (line[end] === '`') end += 1;
      const delimiter = line.slice(cursor, end);
      if (codeDelimiter === null) codeDelimiter = delimiter;
      else if (delimiter === codeDelimiter) codeDelimiter = null;
      out += delimiter;
      cursor = end;
      continue;
    }
    if (codeDelimiter !== null || line[cursor] !== '[') {
      out += line[cursor]!;
      cursor += 1;
      continue;
    }

    const labelEnd = findClosingBracket(line, cursor + 1);
    const destinationStart = labelEnd >= 0 && line[labelEnd + 1] === '(' ? labelEnd + 2 : -1;
    if (destinationStart < 0 || line[destinationStart] === '<') {
      out += line[cursor]!;
      cursor += 1;
      continue;
    }

    const destinationEnd = findClosingParen(line, destinationStart);
    if (destinationEnd < 0) {
      out += line[cursor]!;
      cursor += 1;
      continue;
    }
    const destination = line.slice(destinationStart, destinationEnd);
    if (WINDOWS_DRIVE_PATH.test(destination) && /\s/.test(destination)) {
      out += line.slice(cursor, destinationStart) + `<${destination}>)`;
      cursor = destinationEnd + 1;
    } else {
      out += line.slice(cursor, destinationEnd + 1);
      cursor = destinationEnd + 1;
    }
  }
  return out;
}

function findClosingBracket(line: string, start: number): number {
  let depth = 1;
  for (let i = start; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }
    if (line[i] === '[') depth += 1;
    if (line[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

function findClosingParen(line: string, start: number): number {
  let depth = 1;
  for (let i = start; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }
    if (line[i] === '(') depth += 1;
    if (line[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Characters that require an angle-bracket URL destination in CommonMark.
 * Bare link destinations forbid spaces and unbalanced parentheses.
 */
const NEEDS_ANGLE = /[\s()]/;

/**
 * A label inside `@[…]`: a lone `]` ends the link text and the whole mention is lost (App 引用 pill 实测 10-14: `a]b`,
 * `图 2]` drew no pill at all), so brackets and backslashes are escaped; remark reads the label back unescaped.
 */
const bracketLabel = (label: string) => label.replace(/[\\[\]]/g, (c) => `\\${c}`);

/**
 * Produce the canonical text form of a mention for use as the serialized
 * submit/clipboard text.
 *
 * - File and issue mentions with a target: `@[label](target)`. When the target
 *   contains spaces or parentheses (forbidden in bare CommonMark destinations),
 *   it is wrapped in angle brackets: `@[label](<path with spaces>)`. remark
 *   parses both forms to the same link node, recovering the target verbatim.
 * - Agent mentions(`custom`)同样走括号写法:`@[Claude 1](aid:<Agent ID>)`。裸写法装不下它 ——
 *   agent 的名字必然带空格(`Claude 1`),而裸 token 的字符集不吃空格,`@Claude 1` 只会被解析成
 *   `@Claude`。括号写法让**人看到名字、机器拿到 Agent ID**,一段文字同时满足两边
 *   (owner 2026-09-16 拍板的形状)。
 * - Everything else: `@${target ?? label}` (bare form).
 */
export function stringifyMention(m: {
  label: string;
  target?: string;
  kind: MentionKind | null;
}): string {
  if (m.kind === 'custom' && m.target && m.target !== m.label) {
    const dest = NEEDS_ANGLE.test(m.target) ? `<${m.target}>` : m.target;
    return `@[${bracketLabel(m.label)}](${dest})`;
  }
  if ((m.kind === 'file' || m.kind === 'issue') && m.target) {
    const dest = NEEDS_ANGLE.test(m.target) ? `<${m.target}>` : m.target;
    return `@[${bracketLabel(m.label)}](${dest})`;
  }
  return `@${m.target ?? m.label}`;
}

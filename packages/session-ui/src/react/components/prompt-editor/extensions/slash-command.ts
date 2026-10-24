/**
 * / command extension.
 *
 * Reuses the Mention node infrastructure from @tiptap/extension-mention under a
 * different node name (`slashCommand`) and trigger char (`/`).
 *
 * Behaviors (determined per-item):
 *  - 'insert'  → inserts a slashCommand atom node serialized as its command
 *                token (`/name`, or `$name` when the name carries its own sigil).
 *  - 'insert-text' → inserts the item's raw text directly into the editor.
 *  - 'execute' → calls onCommand(item) and removes the trigger range without
 *                inserting any node.
 */

import { Mention as TipTapMention } from '@tiptap/extension-mention';
import { PluginKey } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import type { SuggestionOptions } from '@tiptap/suggestion';
import { SlashCommandPill } from '../slash-command-pill';
import { fallbackToken } from '../command-token';
import type { CommandItem } from '../types';

const slashCommandPluginKey = new PluginKey('slashCommand');

/** 节点上的原文;老文档(或非 ACP 调用方)没有 token 时按名字兜底。 */
function nodeToken(attrs: Record<string, unknown>): string {
  const token = attrs.token as string | null;
  if (token) return token;
  return fallbackToken((attrs.name as string | null) ?? (attrs.id as string | null) ?? '');
}

function plainTextInsertContent(text: string) {
  const lines = text.length > 0 ? text.split(/\r?\n/) : [''];
  return lines.map((line) => ({
    type: 'paragraph',
    ...(line.length > 0 ? { content: [{ type: 'text', text: line }] } : {}),
  }));
}

export function buildSlashCommandExtension(
  suggestion: Partial<SuggestionOptions<CommandItem>>,
  onExecute: (item: CommandItem) => void
) {
  return TipTapMention.extend({
    name: 'slashCommand',
    addAttributes() {
      return {
        id: { default: null },
        name: { default: null },
        // 宿主算好的原文。芯片显示与序列化都只读它 —— 见 `CommandItem.token`。
        token: { default: null },
      };
    },
    addNodeView() {
      return ReactNodeViewRenderer(SlashCommandPill, { as: 'span' });
    },
  }).configure({
    HTMLAttributes: { class: 'slash-command-chip' },
    renderText({ node }) {
      return nodeToken(node.attrs);
    },
    renderHTML({ node }) {
      return [
        'span',
        {
          'data-type': 'slash-command',
          'data-id': node.attrs.id as string,
          'data-name': node.attrs.name as string,
          class: 'slash-command-chip',
        },
        nodeToken(node.attrs),
      ];
    },
    suggestion: {
      char: '/',
      allowSpaces: false,
      // TipTap interpolates these prefixes into a character class. A command
      // starts a whitespace-delimited token; slashes inside paths are text.
      allowedPrefixes: ['\\s'],
      startOfLine: false,
      pluginKey: slashCommandPluginKey,
      // Wrap the command handler so 'execute' items don't insert a node.
      command({ editor, range, props }) {
        // TipTap types `props` as MentionNodeAttrs; cast to CommandItem since we control what gets passed.
        const item = props as unknown as CommandItem;
        if (item.behavior === 'execute') {
          editor.chain().focus().deleteRange(range).run();
          onExecute(item);
        } else if (item.behavior === 'insert-text') {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContentAt(range.from, plainTextInsertContent(item.insertText ?? ''))
            .run();
        } else {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContentAt(range.from, [
              {
                type: 'slashCommand',
                attrs: {
                  id: item.id,
                  name: item.name ?? item.id,
                  token: item.token ?? fallbackToken(item.name ?? item.id),
                },
              },
              { type: 'text', text: ' ' },
            ])
            .run();
        }
      },
      ...(suggestion as Partial<SuggestionOptions>),
    },
  });
}

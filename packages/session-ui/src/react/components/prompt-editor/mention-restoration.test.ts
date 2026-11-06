import { Schema, type Node } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { mentionRestorationRanges } from './mention-restoration';

const schema = new Schema({ nodes: {
  doc: { content: 'paragraph+' }, paragraph: { content: 'inline*' }, text: { group: 'inline' },
  mention: { inline: true, group: 'inline', atom: true, attrs: { id: {}, label: {}, kind: { default: 'custom' } } },
} });
const item = { id: 'solver', label: 'Solver', kind: 'custom' as const };
const paragraph = (...nodes: Node[]) => schema.nodes.paragraph.create(null, nodes);

describe('selected mention restoration offsets', () => {
  it('maps a saved target after an existing atom and a paragraph boundary', () => {
    const doc = schema.nodes.doc.create(null, [
      paragraph(schema.nodes.mention.create({ id: 'earlier', label: 'Longer name' }), schema.text(' intro')),
      paragraph(schema.text('Ask @Solver now')),
    ]);
    const ranges = mentionRestorationRanges(doc, [{ start: 23, end: 30, item }]);
    expect(ranges).toEqual([{ from: 14, to: 21, item }]);
    expect(doc.textBetween(ranges[0].from, ranges[0].to)).toBe('@Solver');
  });

  it('keeps an existing atomic identity intact rather than recreating it from its name', () => {
    const doc = schema.nodes.doc.create(null, paragraph(schema.nodes.mention.create({ id: 'solver', label: 'Solver' })));
    expect(mentionRestorationRanges(doc, [{ start: 0, end: 7, item }])).toEqual([]);
  });

  it('returns literal replacements in reverse order so earlier offsets remain valid', () => {
    const doc = schema.nodes.doc.create(null, paragraph(schema.text('@Solver and @Solver')));
    expect(mentionRestorationRanges(doc, [{ start: 0, end: 7, item }, { start: 12, end: 19, item }]))
      .toEqual([{ from: 13, to: 20, item }, { from: 1, to: 8, item }]);
  });
});

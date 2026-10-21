/** @jsxImportSource solid-js */
/**
 * Typeset LaTeX stories — inline and display.
 *
 * The stories worth having here are the ones where the geometry is not obvious:
 * a formula taller than the body line, a formula wider than the column, a
 * formula that does not parse, and the same formula written with both delimiter
 * families. A plain `$x$` renders correctly under almost any implementation.
 */

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { ChatHost, ScriptedChat } from '@session-chat/stories/_harness/chat-host';
import { scenario, seedStep, streamMessage } from '@session-chat/stories/_harness/streaming/scenario';

const meta: Meta = {
  title: 'Rows/Markdown/Math',
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj;

export const InlineAndDisplay: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'message',
          id: 'm1',
          role: 'assistant',
          text: [
            'Mass–energy equivalence is $E = mc^2$, and the Gaussian integral evaluates to:',
            '',
            '$$',
            '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}',
            '$$',
            '',
            'which closes the derivation.',
          ].join('\n'),
        },
      ]}
      height={280}
    />
  ),
};

/** A fraction is taller than the body line band, so the line has to grow. */
export const TallInline: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'message',
          id: 'm1',
          role: 'assistant',
          text: [
            'A ratio of ratios, $\\frac{\\frac{a}{b}}{\\frac{c}{d}}$, set inline in a sentence long',
            'enough to wrap, so the grown band is visible next to ordinary lines.',
          ].join(' '),
        },
      ]}
      height={220}
    />
  ),
};

/** Both delimiter families must land on identical output. */
export const LatexDelimiters: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'message',
          id: 'm1',
          role: 'assistant',
          text: [
            'Dollar form: $a^2 + b^2 = c^2$',
            '',
            'LaTeX form: \\(a^2 + b^2 = c^2\\)',
            '',
            '\\[',
            '\\sum_{i=1}^{n} \\frac{x_i^2}{\\sqrt{y_i}} = \\alpha\\beta\\gamma',
            '\\]',
          ].join('\n'),
        },
      ]}
      height={320}
    />
  ),
};

/** KaTeX cannot line-break, so an over-wide formula scrolls rather than reflows. */
export const WiderThanTheColumn: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'message',
          id: 'm1',
          role: 'assistant',
          text: [
            '$$',
            '\\mathcal{L}(\\theta) = \\sum_{i=1}^{N} \\left[ y_i \\log \\sigma(\\theta^\\top x_i) + (1 - y_i) \\log (1 - \\sigma(\\theta^\\top x_i)) \\right] - \\frac{\\lambda}{2} \\lVert \\theta \\rVert_2^2',
            '$$',
          ].join('\n'),
        },
      ]}
      height={220}
    />
  ),
};

export const Unparseable: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'message',
          id: 'm1',
          role: 'assistant',
          text: 'A truncated formula still shows its source: $$\\frac{1}{$$',
        },
      ]}
      height={200}
    />
  ),
};

const STREAMING_BODY = [
  'The normalising constant is\n\n',
  '$$\n',
  'Z = \\int_{-\\infty}^{\\infty} e^{-\\beta H(x)}\\,dx\n',
  '$$\n\n',
  'and the free energy follows as $F = -\\beta^{-1}\\log Z$.',
].join('');

export const Streaming: Story = {
  render: () => (
    <ScriptedChat
      height={300}
      script={scenario(
        [seedStep([{ kind: 'message', id: 'u1', role: 'user', text: 'Derive the free energy' }])],
        streamMessage({ id: 'a1', text: STREAMING_BODY, chunkMs: 60 })
      )}
    />
  ),
};

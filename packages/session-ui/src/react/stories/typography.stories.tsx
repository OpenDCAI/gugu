import type { Meta, StoryObj } from '@storybook/react-vite';
import { cx } from '@session-ui/styles/utilities/cx';
import React from 'react';
import { Box } from '../primitives/box';
import { ThemeProvider } from '../primitives/theme-provider';
import { Heading } from '../primitives/typography/Heading';
import { Text } from '../primitives/typography/Text';
import { textVariants, type TextVariantProps } from '../primitives/typography/typography.variants';
import * as s from '../story-layout.css';
import { sx } from '@session-ui/styles/utilities/sprinkles.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

const meta: Meta = {
  title: 'Theme/Typography',
  parameters: { layout: 'padded' },
};

export default meta;
type Story = StoryObj;

// 咕咕字阶 11/13/15/17/20。取值以 theme/tokens.css.ts 为准,这里的 px 只是给人看的标签。
// ⚠️ 原来这张表写的是 `--text-micro` 这类**不带命名空间前缀**的名字,渲染成
// `var(--text-micro)` —— session-ui 的变量全部带 `--em-` 前缀,所以每一行取到的都是
// undefined,font-size 退回继承值:整个 story 八行长得一模一样,却看不出坏了。
// 改成直接引 tokenVars,名字错了就编不过。
const SIZE_TOKENS = [
  { name: 'textTiny', ref: tokenVars.textTiny, lhRef: tokenVars.textTinyLineHeight, size: '11px' },
  { name: 'textSm', ref: tokenVars.textSm, lhRef: tokenVars.textSmLineHeight, size: '13px' },
  { name: 'textTitle', ref: tokenVars.textTitle, lhRef: tokenVars.textTitleLineHeight, size: '15px' },
  { name: 'textLg', ref: tokenVars.textLg, lhRef: tokenVars.textLgLineHeight, size: '17px' },
  { name: 'textXl', ref: tokenVars.textXl, lhRef: tokenVars.textXlLineHeight, size: '20px' },
];

const WEIGHT_TOKENS = [
  { name: '--font-weight-normal', value: 400, label: 'Normal 400' },
  { name: '--font-weight-medium', value: 500, label: 'Medium 500' },
  { name: '--font-weight-semibold', value: 600, label: 'Semibold 600' },
  { name: '--font-weight-bold', value: 700, label: 'Bold 700' },
];

/** Primitive type size scale — each --text-* token. */
export const TypeScale: Story = {
  render: () => (
    <Box display="flex" flexDirection="column" gap="2" padding="4">
      <Box marginBottom="4">
        <h2 className={cx(sx({ fontSize: 'sm', fontWeight: 'semibold', color: 'foreground' }))}>
          Type size scale
        </h2>
        <p className={cx(sx({ marginTop: '1', fontSize: 'tiny', color: 'foregroundMuted' }))}>
          Primitive <code className={cx(sx({ fontFamily: 'mono' }))}>--text-*</code> tokens.
          Semantic{' '}
          <code className={cx(sx({ fontFamily: 'mono' }))}>--type-&lt;role&gt;-font-size</code>{' '}
          values reference these.
        </p>
      </Box>
      {SIZE_TOKENS.map(({ name, ref, lhRef, size }) => (
        <Box key={name} display="flex" alignItems="baseline" gap="4">
          <Box
            display="flex"
            flexDirection="column"
            flexShrink={0}
            className={s.w48}
            style={{ textAlign: 'right' }}
          >
            <code
              className={cx(sx({ fontFamily: 'mono', fontSize: 'tiny', color: 'foregroundPassive' }))}
            >
              {name}
            </code>
            <span className={cx(sx({ fontSize: 'tiny', color: 'foregroundPassive' }))}>
              {size}
            </span>
          </Box>
          <span
            style={{ fontSize: ref, lineHeight: lhRef }}
            className={cx(sx({ color: 'foreground' }))}
          >
            The quick brown fox jumps over the lazy dog.
          </span>
        </Box>
      ))}
    </Box>
  ),
};

/** Font weight scale — each --font-weight-* token. */
export const Weights: Story = {
  render: () => (
    <Box display="flex" flexDirection="column" gap="4" padding="4">
      <Box marginBottom="2">
        <h2 className={cx(sx({ fontSize: 'sm', fontWeight: 'semibold', color: 'foreground' }))}>
          Font weight scale
        </h2>
        <p className={cx(sx({ marginTop: '1', fontSize: 'tiny', color: 'foregroundMuted' }))}>
          Primitive <code className={cx(sx({ fontFamily: 'mono' }))}>--font-weight-*</code> tokens.
        </p>
      </Box>
      {WEIGHT_TOKENS.map(({ name, value, label }) => (
        <Box key={name} display="flex" alignItems="baseline" gap="4">
          <Box
            display="flex"
            flexDirection="column"
            flexShrink={0}
            className={s.w48}
            style={{ textAlign: 'right' }}
          >
            <code
              className={cx(sx({ fontFamily: 'mono', fontSize: 'tiny', color: 'foregroundPassive' }))}
            >
              {name}
            </code>
            <span className={cx(sx({ fontSize: 'tiny', color: 'foregroundPassive' }))}>{value}</span>
          </Box>
          <span
            style={{ fontWeight: `var(${name})` }}
            className={cx(sx({ fontSize: 'title', color: 'foreground' }))}
          >
            {label}: The quick brown fox jumps over the lazy dog.
          </span>
        </Box>
      ))}
    </Box>
  ),
};

const ROLES: Array<{ label: string; variant: TextVariantProps['variant']; as?: string }> = [
  { label: 'h1 — 20px / 600', variant: 'h1', as: 'p' },
  { label: 'h2 — 17px / 600', variant: 'h2', as: 'p' },
  { label: 'h3 — 15px / 600', variant: 'h3', as: 'p' },
  { label: 'body — 13px / 400', variant: 'body', as: 'p' },
  { label: 'bodyBold — 13px / 600', variant: 'bodyBold', as: 'p' },
  { label: 'bodyItalic — 13px / 400 italic', variant: 'bodyItalic', as: 'p' },
  { label: 'bodyLink — 13px / 400', variant: 'bodyLink', as: 'p' },
  { label: 'inlineCode — 0.92em / 400 mono', variant: 'inlineCode', as: 'p' },
  { label: 'code — 13px / 400 mono', variant: 'code', as: 'p' },
  { label: 'codeLang — 11px / 500 sans', variant: 'codeLang', as: 'p' },
  { label: 'mention — 13px / 600', variant: 'mention', as: 'p' },
];

/** Every typography role applied to a sample sentence. */
export const AllRoles: Story = {
  render: () => (
    <Box display="flex" flexDirection="column" gap="4">
      {ROLES.map(({ label, variant }) => (
        <Box key={variant} display="flex" alignItems="baseline" gap="4">
          <span
            className={cx(
              sx({ fontFamily: 'mono', fontSize: 'tiny', color: 'foregroundPassive', flexShrink: 0 }),
              s.w52
            )}
          >
            {label}
          </span>
          <Text as="p" variant={variant} tone="default">
            The quick brown fox jumps over the lazy dog.
          </Text>
        </Box>
      ))}
    </Box>
  ),
};

/** Heading component: levels 1–3. */
export const Headings: Story = {
  render: () => (
    <Box display="flex" flexDirection="column" gap="3">
      <Heading level={1}>Heading level 1 — 20px / 600</Heading>
      <Heading level={2}>Heading level 2 — 17px / 600</Heading>
      <Heading level={3}>Heading level 3 — 15px / 600</Heading>
    </Box>
  ),
};

/** Tone variants — default, muted, passive. */
export const Tones: Story = {
  render: () => (
    <Box display="flex" flexDirection="column" gap="2">
      {(['default', 'muted', 'passive'] as const).map((tone) => (
        <Text key={tone} as="p" variant="body" tone={tone}>
          tone="{tone}": The quick brown fox jumps over the lazy dog.
        </Text>
      ))}
    </Box>
  ),
};

/** className extension — role + extra utility classes. */
export const ClassExtension: Story = {
  render: () => (
    <Box display="flex" flexDirection="column" gap="2">
      <Text
        as="p"
        variant="body"
        className={cx(sx({ fontStyle: 'italic', textDecoration: 'underline' }))}
      >
        className extension: italic + underline applied after role.
      </Text>
      <Heading level={2} className={cx(sx({ color: 'foregroundMuted' }))}>
        Muted h2 via className
      </Heading>
    </Box>
  ),
};

/** textVariants recipe used directly (no component wrapper). */
export const RecipeDirectUse: Story = {
  render: () => (
    <Box display="flex" flexDirection="column" gap="2">
      <p className={textVariants({ variant: 'h1', tone: 'default' })}>
        textVariants — h1 role, default tone
      </p>
      <p className={textVariants({ variant: 'body', tone: 'muted' })}>
        textVariants — body role, muted tone
      </p>
    </Box>
  ),
};

/** All surfaces side-by-side to confirm readability. */
export const AllSurfaces: Story = {
  render: () => (
    <Box display="grid" className={s.cols5} gap="3">
      {(['sunken', 'base', 'base-emphasis', 'elevated', 'elevated-emphasis'] as const).map((sv) => (
        <Box key={sv} surface={sv} rounded="md" padding="4">
          <p
            className={cx(
              sx({
                marginBottom: '1',
                fontFamily: 'mono',
                fontSize: 'tiny',
                color: 'foregroundPassive',
              })
            )}
          >
            .surface-{sv}
          </p>
          <Heading level={2} className={cx(sx({ marginBottom: '1' }))}>
            Heading
          </Heading>
          <Text as="p" variant="body" tone="default">
            Body text on this surface.
          </Text>
          <Text as="p" variant="body" tone="muted">
            Muted body text.
          </Text>
        </Box>
      ))}
    </Box>
  ),
};

/** Light and dark modes side-by-side. */
export const BothModes: Story = {
  render: () => (
    <Box display="flex" className={cx(s.minHScreen, s.divideX, s.divideBorder)}>
      <ThemeProvider
        defaultTheme="light"
        className={cx(sx({ flex: '1', background: 'background', padding: '8' }))}
      >
        <Heading level={1} className={cx(sx({ marginBottom: '2' }))}>
          Light mode
        </Heading>
        <Text as="p" variant="body" tone="default" className={cx(sx({ marginBottom: '1' }))}>
          Body text
        </Text>
        <Text as="p" variant="body" tone="muted">
          Muted body text
        </Text>
      </ThemeProvider>
      <ThemeProvider
        defaultTheme="dark"
        className={cx(sx({ flex: '1', background: 'background', padding: '8' }))}
      >
        <Heading level={1} className={cx(sx({ marginBottom: '2' }))}>
          Dark mode
        </Heading>
        <Text as="p" variant="body" tone="default" className={cx(sx({ marginBottom: '1' }))}>
          Body text
        </Text>
        <Text as="p" variant="body" tone="muted">
          Muted body text
        </Text>
      </ThemeProvider>
    </Box>
  ),
};

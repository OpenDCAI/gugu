import type { Meta, StoryObj } from '@storybook/react-vite';
import { cx } from '@session-ui/styles/utilities/cx';
import React from 'react';
import { Box } from '../primitives/box';
import * as s from '../story-layout.css';
import { sx } from '@session-ui/styles/utilities/sprinkles.css';

const meta: Meta = {
  title: 'Theme/Rounding',
  parameters: { layout: 'padded' },
};

export default meta;
type Story = StoryObj;

// @@@shape-table (Refs #6109) — 这张表跟着 design.md 的 8 档语义表重画了。
//
// 2026-09-22 之前它写的是「`xl` / `2xl` 越界，勿用（#3334 §5）」，理由是本包的基准圆角封顶
// 在 md(8px)、而 xl 当时是 **14px** —— 14 在任何一张刻度上都没有对应值。那条旧文案现在
// **整个作废**：档位本身换了（xl 落到 12px，就是「浮起来的卡片」那一档，正式解禁），
// 20px 那一档改名 `thread`(16px)，语义是 composer 与用户气泡。
//
// 现在越界的判据不再是「哪一档不许用」，而是**有没有落在表上**：表里没有的值（4px、14px、
// 20px…）一律不许写，写了就是第九档。⇒ `forbidden` 这一栏留着给未来的越界档，当前为空。
const RADIUS_TOKENS: Array<{ name: string; var: string; label: string; forbidden?: true }> = [
  { name: 'xs', var: '--radius-xs', label: '6px（= document：印在页上的东西）' },
  { name: 'sm', var: '--radius-sm', label: '6px（kbd、行内代码、最小的图标钮）' },
  { name: 'md', var: '--radius-md', label: '8px（= control：按钮、输入框、头部 CTA）' },
  { name: 'surface', var: '--radius-surface', label: '10px（菜单、popover、tooltip）' },
  { name: 'xl', var: '--radius-xl', label: '12px（对话框、toast、浮起来的卡片）' },
  { name: 'thread', var: '--radius-thread', label: '24px（composer）' },
  { name: 'full', var: '--radius-full', label: '9999px（= capsule：switch、头像、状态点）' },
];

/** All radius tokens with swatches showing the curvature. */
export const Scale: Story = {
  render: () => (
    <Box display="flex" flexDirection="column" gap="6" padding="4">
      <Box>
        <h2 className={cx(sx({ fontSize: 'sm', fontWeight: 'semibold', color: 'foreground' }))}>
          Radius scale
        </h2>
        <p className={cx(sx({ marginTop: '1', fontSize: 'tiny', color: 'foregroundMuted' }))}>
          Each swatch uses{' '}
          <code className={cx(sx({ fontFamily: 'mono' }))}>border-radius: var(--em-radius-*)</code>.
          The anchor is <code className={cx(sx({ fontFamily: 'mono' }))}>--radius: 0.5rem</code>;
          change it to rescale the whole system.
        </p>
      </Box>
      <Box display="grid" gap="6" className={cx(s.cols4, s.lgCols7)}>
        {RADIUS_TOKENS.map(({ name, var: cssVar, label, forbidden }) => (
          <Box key={name} display="flex" flexDirection="column" alignItems="center" gap="3">
            <Box
              background="surfaceBaseEmphasis"
              borderWidth="2"
              borderStyle="solid"
              borderColor={forbidden ? 'borderDestructive' : 'border'}
              className={cx(s.h16, s.w16)}
              style={{ borderRadius: `var(${cssVar})`, opacity: forbidden ? 0.4 : undefined }}
            />
            <Box textAlign="center">
              <p
                className={cx(
                  sx({
                    fontFamily: 'mono',
                    fontSize: 'tiny',
                    fontWeight: 'medium',
                    color: 'foreground',
                  })
                )}
              >
                {cssVar}
              </p>
              <p
                className={cx(
                  sx({ fontFamily: 'mono', color: 'foregroundPassive', marginTop: '0.5' }),
                  s.text10px
                )}
              >
                {label}
              </p>
              {forbidden && (
                <p
                  className={cx(
                    sx({ fontWeight: 'medium', color: 'foregroundDestructive', marginTop: '0.5' }),
                    s.text10px
                  )}
                >
                  ❌ 不在 8 档表上，勿用
                </p>
              )}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  ),
};

/** Controls and inputs use the token scale. */
export const InContext: Story = {
  render: () => (
    <Box display="flex" flexDirection="column" gap="6" padding="4">
      <Box>
        <h2 className={cx(sx({ fontSize: 'sm', fontWeight: 'semibold', color: 'foreground' }))}>
          Tokens in use
        </h2>
        <p className={cx(sx({ marginTop: '1', fontSize: 'tiny', color: 'foregroundMuted' }))}>
          Buttons and inputs both use{' '}
          <code className={cx(sx({ fontFamily: 'mono' }))}>--radius-md</code> —— 控件那一档（8px），
          与 renderer 的 <code className={cx(sx({ fontFamily: 'mono' }))}>--radius-control</code> 等值。
          更大的档位各有自己的语义（surface / xl / thread），❌ 不是「更圆一点」的程度选项。
        </p>
      </Box>
      <Box display="flex" flexWrap="wrap" alignItems="center" gap="3">
        <button
          type="button"
          className={cx(
            sx({
              background: 'surfaceHover',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '1.5',
              rounded: 'md',
              borderWidth: '1',
              borderStyle: 'solid',
              borderColor: 'transparent',
              px: '2.5',
              fontSize: 'sm',
              color: 'foreground',
            }),
            s.h8
          )}
        >
          Base button (--radius-md)
        </button>
        <button
          type="button"
          className={cx(
            sx({
              background: 'surfaceHover',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '1',
              rounded: 'md',
              borderWidth: '1',
              borderStyle: 'solid',
              borderColor: 'transparent',
              px: '2',
              fontSize: 'tiny',
              color: 'foreground',
            }),
            s.h6
          )}
        >
          SM button (--radius-md)
        </button>
        <input
          type="text"
          placeholder="Input (--radius-md)"
          className={cx(
            sx({
              background: 'surface',
              rounded: 'md',
              borderWidth: '1',
              borderStyle: 'solid',
              borderColor: 'border',
              px: '2.5',
              fontSize: 'sm',
              color: 'foreground',
            }),
            s.h8,
            s.outlineNone
          )}
        />
      </Box>
    </Box>
  ),
};

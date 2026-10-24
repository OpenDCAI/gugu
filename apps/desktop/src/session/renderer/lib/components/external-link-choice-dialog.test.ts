import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from '@renderer/lib/ui/dialog';
import { ExternalLinkChoiceDialog } from './external-link-choice-dialog';

// 文案走真 zh-CN 词表：词表缺 key 时 translate 得到 undefined，下面的断言就会红。
vi.mock('@renderer/localization/use-session-messages', async () => {
  const { zhCNMessages } = await import('@renderer/localization/messages');
  return {
    useSessionMessages: () => ({
      locale: 'zh-CN',
      translate: (key: keyof typeof zhCNMessages) => zhCNMessages[key],
    }),
  };
});

function renderDialog(): string {
  return renderToStaticMarkup(
    createElement(
      Dialog,
      { open: true },
      createElement(ExternalLinkChoiceDialog, {
        url: 'https://example.com/docs',
        canOpenInEmdashBrowser: true,
        onCopy: vi.fn(() => true),
        onSuccess: vi.fn(),
        onClose: vi.fn(),
      })
    )
  );
}

describe('ExternalLinkChoiceDialog', () => {
  it('offers a copy action inside the displayed external link', () => {
    const html = renderDialog();

    expect(html).toContain('https://example.com/docs');
    expect(html).toContain('aria-label="复制链接"');
  });

  it('renders its labels in the viewer language instead of hard-coded English', () => {
    const html = renderDialog();

    for (const text of [
      '打开链接？',
      '在 gugu 浏览器中打开',
      '在系统浏览器中打开',
      '取消',
    ]) {
      expect(html).toContain(text);
    }
    for (const english of [
      'Open link?',
      'Open in gugu Browser',
      'Open in Browser',
      '>Cancel<',
    ]) {
      expect(html).not.toContain(english);
    }
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CliInstallProgress } from './CliInstallProgress';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('CliInstallProgress', () => {
  // 已装好 / 云电脑预装时主进程给的进度是 null:只说在准备连接,❌ 下载进度条或「正在准备下载」。
  it('shows only the idle line until a real download reports progress', () => {
    const html = renderToStaticMarkup(
      <CliInstallProgress read={async () => null} idle={<p>preparing-connection</p>} />
    );
    expect(html).toBe('<p>preparing-connection</p>');
    expect(html).not.toContain('download');
  });

  it('renders nothing when the caller already says it is preparing', () => {
    expect(renderToStaticMarkup(<CliInstallProgress read={async () => null} />)).toBe('');
  });
});

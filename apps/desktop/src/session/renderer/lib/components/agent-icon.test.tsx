import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentIconAsset } from '@shared/core/agents/agent-payload';
import { AGENT_ICONS_QUERY_KEY } from '../stores/use-agents';
import { AgentIcon } from './agent-icon';

// 图标读的是主题真值那份存储(host-theme;ThemeProvider 读的也是它),不经会话页的 ThemeContext。
vi.mock('@renderer/lib/theme/host-theme', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readHostTheme: () => 'emdark',
  subscribeToHostTheme: () => () => {},
}));

// 图标表经 `agents.listIcons` 从主进程来(useAgentIcons);这里直接放进 query 缓存,❌ 起 RPC。
// 两枚样本按行为命名,❌ 借真家的图:哪家有暗色原图、哪家靠反色,随插件的图改
// (grok 就从「反色」换成了自带暗色原图,这个文件从前按 grok 判反色)。
const ICONS: Record<string, AgentIconAsset> = {
  'invert-mark': {
    kind: 'svg',
    invertInDark: true,
    variants: [{ minSize: 0, light: '<svg data-art="light"></svg>' }],
  },
  'dark-art-mark': {
    kind: 'svg',
    variants: [{ minSize: 0, light: '<svg data-art="light"></svg>', dark: '<svg data-art="dark"></svg>' }],
  },
};

function render(node: ReactElement): string {
  const client = new QueryClient();
  client.setQueryData(AGENT_ICONS_QUERY_KEY, ICONS);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('AgentIcon', () => {
  it('renders nothing for an unknown agent id', () => {
    const html = render(<AgentIcon id="unknown-agent-xyz" />);
    expect(html).toBe('');
  });

  it('renders a light-only mark in dark mode with invert filter applied', () => {
    const html = render(<AgentIcon id="invert-mark" size={16} />);
    expect(html).toContain('data-art="light"');
    expect(html).toContain('invert');
  });

  it('renders a mark with its own dark art in dark mode using that art, not inverted', () => {
    const html = render(<AgentIcon id="dark-art-mark" size={16} />);
    expect(html).toContain('data-art="dark"');
    expect(html).not.toContain('invert');
  });

  it('applies grayscale class when grayscale prop is true', () => {
    const html = render(<AgentIcon id="dark-art-mark" size={16} grayscale />);
    expect(html).toContain('grayscale');
  });

  it('passes className to the wrapper span', () => {
    const html = render(<AgentIcon id="dark-art-mark" size={16} className="rounded-sm" />);
    expect(html).toContain('rounded-sm');
  });
});

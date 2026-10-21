/**
 * 发给对方 agent 的那份身份事实(隐藏说明)。
 *
 * 这段东西是**静默失败高危区**:它不在界面上,写空了没有任何人会看见 —— 收信的 agent 只是
 * 拿到一个没人给它解释的地址。2026-09-16 把 @ 的文本从裸的 `@user:<id>` 换成
 * `@[Claude 1](aid:<Agent ID>)` 时,这里的扫描口径必须跟着换;不换就正好落进那种没人发现的空。
 */
import { describe, expect, it, vi } from 'vitest';
import type { MentionItem } from '@gugu/session-ui/react/components';

// 被测的是一个纯文本函数,但它住在一个 import 期就会把整张 store 图拉起来的模块里:
// `AppState` 的构造会发一个在 node 环境必失败的 RPC,于是**断言全过、退出码却是 1**
// (vitest 的 Unhandled Errors)。存根掉这条 import 边,判据才落在它自己身上。
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ projects: new Map() }),
}));
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: { get: () => undefined },
}));

const { localSessionMentionHiddenContext } = await import(
  '@renderer/lib/chat/local-session-mention-provider'
);

const ID = 'd24d4986-40c5-479a-90be-cbc66cbd35e8';

const agent = (label: string): MentionItem => ({
  id: label,
  label,
  name: 'Claude 1',
  kind: 'custom',
  role: 'agent',
});

describe('localSessionMentionHiddenContext', () => {
  it('认现在写出去的括号写法,并把名字和地址都交给对方', () => {
    const fact = localSessionMentionHiddenContext(
      `@[Claude 1](aid:${ID}) 你看一下`,
      [agent(`aid:${ID}`)],
    );
    expect(fact).toContain('Claude 1');
    expect(fact).toContain(`aid:${ID}`);
    expect(fact).toBe(`"@Claude 1" = aid:${ID} (agent)`);
  });

  it('也认改名之前的裸写法,并归一到新地址', () => {
    const fact = localSessionMentionHiddenContext(
      `@user:${ID} 你看一下`,
      [agent(`aid:${ID}`)],
    );
    expect(fact).toContain(`aid:${ID}`);
    expect(fact).not.toContain(`user:${ID}`);
  });

  it('同一条会话新旧两种写法同时出现时,只写一遍 —— ❌ 同一个 agent 的身份事实不许重复', () => {
    const fact = localSessionMentionHiddenContext(
      `@[Claude 1](aid:${ID}) 和 @user:${ID}`,
      [agent(`aid:${ID}`)],
    );
    expect(fact?.split('\n')).toHaveLength(1);
  });

  it('文本里没有提及时不产生任何东西', () => {
    expect(localSessionMentionHiddenContext('就是一句普通的话', [agent(`aid:${ID}`)])).toBeUndefined();
  });

  it('名册里查不到那个地址时不编造事实', () => {
    expect(
      localSessionMentionHiddenContext(`@[Someone](aid:${ID}) 你看一下`, []),
    ).toBeUndefined();
  });
});

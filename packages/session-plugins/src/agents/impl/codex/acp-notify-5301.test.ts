import { describe, expect, it } from 'vitest';
import { provider } from './index';
import { codexNotifyConfigValue } from './hooks';
import { GUGU_CODEX_NOTIFY_CONFIG_ENV } from './session-bundle';

/**
 * @@@5301 owner 实机撞到的那条腿。
 *
 * 咕咕起 codex 会话有三条路,`notify`(agent 事件 hook)原本只挂在 prompt(TUI 直起)那条上。
 * 他会话页里的会话走的是**第三条**:咕咕自建的 ACP 桥(`runtime/codex-app-server-acp.mjs`)。
 * 这条腿拿不到 notify ⇒ 一条 hook 事件都发不出来 ⇒ 没有 `stop` 事件 ⇒ maybeShowNotification
 * 永不被调到 ⇒ **agent 跑完没有系统横幅**。这条腿此前没有任何用例,所以那个缺口是静默的。
 *
 * @@@5380 门改了,命题没改。#5301 是拼进 argv(桥把 argv 原样转发给 `codex app-server`),
 * 而 #5363 已把 MCP 从 argv 迁到原生 thread-open `config` map ⇒ 两条并存就是同一个进程两扇门。
 * 现在 notify 经这个 env 交给桥,由桥并进**同一张** config map。⇒ 判据钉的是「桥收得到」,
 * 且**argv 上不许再有** —— 后者正是旧门的回归闸。
 */
const BRIDGE = '/x/gugu-codex-app-server-acp.mjs';

// 桥入口由宿主按 `acp.bridge` 声明解析好递进来(#6394);`adapterEntry: null` = 宿主没递。
function spawn(adapterEntry: string | null = BRIDGE) {
  return provider.behavior.acp!.buildSpawn({
    cwd: '/tmp/w',
    env: { GUGU_CODEX_BIN: '/x/codex' },
    cli: 'codex',
    ...(adapterEntry ? { adapterEntry } : {}),
  });
}

describe('codex ACP spawn', () => {
  it('把 notify 交给咕咕自建桥的 config 通道 —— 否则任务页跑完不发系统通知', () => {
    const { args, env } = spawn();

    expect(args[0]).toBe(BRIDGE);
    const raw = env?.[GUGU_CODEX_NOTIFY_CONFIG_ENV];
    expect(raw, '桥没收到 notify ⇒ 这条腿一条 hook 事件都发不出来').toBeTypeOf('string');
    expect(JSON.parse(raw as string)).toEqual(codexNotifyConfigValue());
    // 出处标记必须在里面 —— `isLegacyCodexNotify` 靠它认出「这份是咕咕写的」。
    expect(raw).toContain('GUGU_HOOK_PORT');
  });

  it('❌ 不再把 notify 拼进 argv —— 那是 #5363 之后的第二扇门', () => {
    // 只钉 notify 这一格:`-c` 本身另有正当用途(平台模型层),把它一并禁掉会让这条判据
    // 在无关改动上乱红,那就不再是「第二扇门」的闸了。
    expect(spawn().args.some((arg) => arg.startsWith('notify='))).toBe(false);
  });

  // 阴控:宿主没递桥入口时**当场报错**,❌ 不再回落到上游 `@agentclientprotocol/codex-acp`(#6394)——
  // 那座桥没有 notify / 平台模型目录 / MCP 关闭集合这些通道,回落过去是静默的「两个 adapter」。
  // 这条同时证明上面两条不是「对任何输入都为真」。
  it('宿主没递桥入口 ⇒ 当场报错,不回落到上游 codex-acp', () => {
    expect(() => spawn(null)).toThrow(/adapterEntry/);
  });

  it('声明的是咕咕自带的 app-runtime 桥', () => {
    expect(provider.behavior.acp!.bridge).toEqual({ kind: 'app-runtime', file: 'codex-app-server-acp.mjs' });
  });
});

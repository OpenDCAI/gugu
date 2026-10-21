// #7199 一个 agent「开子 agent 不指定 harness 时用哪个」—— 显式配置,按 agent 记。
//
// 由建它的那一方在 agent.create 时写上(云电脑管家给个人助理写 claude:助理跑什么都行,子 agent 默认 Claude Code)。
// session_spawn 不传 harness 时先读它,没配才继承调用方自己的 harness。❌ 从环境变量 / 机器种类推断:
// 这是这个 agent 的设置,不是这台机器的。
//
// 按 Agent ID 记、不按会话 id:agent 的会话会被换掉(停放 / 改绑),设置跟着 agent 走。
// 存在 kv 表(与 platform-model-selection.ts 同一个理由:sessions.config 的 zod schema 会静默丢掉未声明的键)。

import { KV } from '@main/db/kv';

type ChildHarnessRecord = { harness: string };

const childHarnessKV = new KV<Record<string, ChildHarnessRecord>>('agent-child-harness-default');

/** 记下这个 agent 的子 agent 默认 harness。记不下就让建 agent 那一步失败 —— ❌ 建出一个设置丢了的 agent。 */
export async function recordChildHarnessDefault(agentUserId: string, harness: string): Promise<void> {
  await childHarnessKV.setOrThrow(agentUserId, { harness });
}

/** 这个 agent 的子 agent 默认 harness;没配 = undefined。 */
export async function childHarnessDefault(agentUserId: string): Promise<string | undefined> {
  const record = await childHarnessKV.get(agentUserId);
  return record?.harness || undefined;
}

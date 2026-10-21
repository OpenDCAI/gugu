// gugu#7199:云电脑上建 agent 不建「云电脑」项目群 —— 那台机器上的项目是 agent 的落脚处,用户看不见;
// 建群把内部结构露成聊天列表里一个莫名的群(owner 10-15 经统筹)。建群只看 groupProjectIdFor 给的项目 id:'' = 不建、不进群。
import { describe, expect, it } from 'vitest'
import {
  groupProjectIdFor,
  IMPLICIT_SESSION_HOME_PROJECT_ID,
} from '../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning'

describe('groupProjectIdFor(建群看的项目 id)', () => {
  it('云电脑(GUGU_CLOUD_COMPUTER=1)上的项目不建群', () => {
    expect(groupProjectIdFor('p-cloud', { GUGU_CLOUD_COMPUTER: '1' })).toBe('')
  })

  it('正对照:别的机器(桌面、自己用 SSH 加的 server)照旧「项目 = 群」', () => {
    expect(groupProjectIdFor(' p-repo ', {})).toBe('p-repo')
    expect(groupProjectIdFor('p-repo', { GUGU_CLOUD_COMPUTER: '0' })).toBe('p-repo')
    expect(groupProjectIdFor('p-repo', { GUGU_SERVER_MODE: '1' })).toBe('p-repo')
  })

  it('隐式任务工作区、没有项目:照旧不建群', () => {
    expect(groupProjectIdFor(IMPLICIT_SESSION_HOME_PROJECT_ID, {})).toBe('')
    expect(groupProjectIdFor(null, {})).toBe('')
    expect(groupProjectIdFor('  ', {})).toBe('')
  })
})

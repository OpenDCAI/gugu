import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'

// 同步阻塞在一个子进程上:worker 的事件循环被占住,只有主进程的在飞心跳还能报出「卡在这里」。
test('blocks its worker synchronously on a child process', () => {
  spawnSync('/bin/sleep', ['2'])
  expect('blocked case finished').toBe('deliberately red so the cell can read the run')
})

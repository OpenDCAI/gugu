import { describe, expect, it } from 'vitest';
// @ts-expect-error -- 检查脚本是无类型的 .mjs,和仓里其它 scripts 用例同一写法。
import { analyzeSource, isScannedFile } from '../../../scripts/checks/error-outlet-check.mjs';

type Analysis = { emitterSites: { name: string; line: number }[]; outlets: number; violation: boolean };
const analyze = (file: string, source: string): Analysis =>
  (analyzeSource as (file: string, source: string) => Analysis)(file, source);

// @@@unhandled-error-event (#4942) — 这一组是那道守卫自己的双向对照。
//
// 守卫的存在不等于守卫能判假。所以每条都指名它要防的失败模式,再问「我这个合成输入,在那个失败模式下会不会
// 仍然通过」。输入全是合成的:要证的是**判据能不能识别**,不是「真仓库里能不能长出一个违规」。

describe('error-outlet guard (#4942)', () => {
  it('阳控:起了子进程却通篇没有 error 出口 → 必须判红', () => {
    // 防的失败模式:判据写窄了(比如只认某个 import 形状),于是真违规溜过去、递给你一句「干净」。
    const result = analyze(
      'apps/desktop/electron/thing.ts',
      `import { spawn } from 'node:child_process';
       export function start() {
         const child = spawn('git', ['status']);
         child.once('exit', () => {});
         return child;
       }`
    );

    expect(result.violation).toBe(true);
    expect(result.emitterSites.map((site) => site.name)).toEqual(['spawn']);
    expect(result.outlets).toBe(0);
  });

  it('阴控:同一段代码只多挂一句 error 监听 → 必须判绿', () => {
    // 与阳控**只差被指名的那一个自由度**:多了 `child.on('error', ...)` 这一行,其余一字不改。
    // 差得更多,这次通过就是空的。
    const result = analyze(
      'apps/desktop/electron/thing.ts',
      `import { spawn } from 'node:child_process';
       export function start() {
         const child = spawn('git', ['status']);
         child.on('error', (error) => report(error));
         child.once('exit', () => {});
         return child;
       }`
    );

    expect(result.violation).toBe(false);
    expect(result.outlets).toBe(1);
  });

  it('认得共享助手,不逼所有人手写 on(error)', () => {
    // ⚠️ 这里的 import 是必需的:少了它,这条会因为「压根没识别出发射器」而判绿 —— 阴控为一个
    // 错误的理由通过,等于什么也没考到。先钉住发射器确实被认出来了,再看它有没有被放行。
    const result = analyze(
      'packages/session-core/src/thing.ts',
      `import { spawn } from 'node:child_process';
       import { onErrorEvents } from '@gugu/session-shared';
       const child = spawn('git', ['cat-file', '--batch']);
       onErrorEvents([child, child.stdin], (error) => report(error));`
    );

    expect(result.emitterSites).toHaveLength(1);
    expect(result.outlets).toBe(1);
    expect(result.violation).toBe(false);
  });

  it('挂的是别的事件不算数 — exit 不是 error', () => {
    // 防的失败模式:判据只看「有没有调用 .on(」,那么任何一句 onData/onExit 都能把违规洗白。
    const result = analyze(
      'apps/desktop/electron/thing.ts',
      `import { spawn } from 'node:child_process';
       const child = spawn('git', ['status']);
       child.on('exit', () => {});
       child.stdout.on('data', () => {});`
    );

    expect(result.violation).toBe(true);
  });

  it('我们自己的 host.spawn(...) 不算 — 它不产生任何 node 发射器', () => {
    // 防的失败模式:只按函数名判。第一版就是这样,把 wire 层的进程抽象一并算了进来 —— 基线里塞满噪声,
    // 真债务反而藏在中间。判据因此要求能追溯到 node 的 child_process / net / http / tls 或 ws。
    const result = analyze(
      'packages/session-wire/src/util/process-runtime/process-runtime.ts',
      `import type { ProcessHost } from '../../process/types';
       export async function spawnRuntime(options: { host: ProcessHost }) {
         const managed = await options.host.spawn({ entry: 'worker' });
         return managed;
       }`
    );

    expect(result.violation).toBe(false);
    expect(result.emitterSites).toHaveLength(0);
  });

  it('没起任何发射器的文件不该被卷进来', () => {
    const result = analyze('packages/session-core/src/pure.ts', `export const add = (a: number, b: number) => a + b;`);

    expect(result.violation).toBe(false);
    expect(result.emitterSites).toHaveLength(0);
  });

  it('套接字与服务端也算长命发射器', () => {
    expect(analyze('a.ts', `import { WebSocket } from 'ws';\nconst socket = new WebSocket(url);`).violation).toBe(
      true
    );
    expect(
      analyze('b.ts', `import http from 'node:http';\nconst server = http.createServer(handler);`).violation
    ).toBe(true);
  });

  it('扫描面:测试与 fixture 明确排除,产品代码明确纳入', () => {
    // 这条钉的是那个有意的取舍本身 —— 排除是写下来的决定,不是某天悄悄漂移的结果。
    expect(isScannedFile('apps/desktop/electron/main.ts')).toBe(true);
    expect(isScannedFile('packages/session-wire/src/process/supervisor.test.ts')).toBe(false);
    expect(isScannedFile('packages/session-wire/src/process/node/fixtures/echo-child.mjs')).toBe(false);
    expect(isScannedFile('docs/notes.md')).toBe(false);
  });
});

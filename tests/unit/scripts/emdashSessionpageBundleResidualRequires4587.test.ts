// @@@4587 —— 「打包成功 ≠ 产物能跑」的闸。
//
// #4585 把 jsonc-parser 引进 sessionpage 图,它的 `main` 是 UMD 壳,bundler 无法静态解析
// 工厂参数化的 `require("./impl/format")`,产物里残留包内相对 require ⇒ built app 的
// sessionpage 后端整个起不来 —— 而当时 quality 四门连那条 esbuild 打包都不跑。
//
// @@@4865 之后会话页主进程图是 electron-main 同一次 rollup 的入口,闸挂在该构建的 writeBundle
// 上(sessionpageResidualRequireGate),CI 的 build:app 每个 PR 都真跑一遍。这里只验闸本身的
// 可判假性:fixture 是**合成**的,❌ 不读真实产物 —— 真实产物被修好后,读它的断言会退化成
// 平凡真(棘轮元测试读活 baseline 栽过的形状)。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

describe('electron-main residual-require gate (tooling gate for #4587)', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'residual-require-gate-'));

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('throws on a synthetic residue and names it', async () => {
    const { assertNoResidualRelativeRequires } = await import(
      '../../../apps/desktop/electron/sessionpage/sessionpage-main-build.mjs'
    );
    const bad = join(outDir, 'synthetic-bad.js');
    writeFileSync(bad, 'const formatter = require2("./impl/format");\n');
    expect(() => assertNoResidualRelativeRequires(bad)).toThrowError(/\.\/impl\/format/);
  });

  it('accepts a relative require whose target really exists next to the bundle (rollup shared chunk)', async () => {
    const { assertNoResidualRelativeRequires } = await import(
      '../../../apps/desktop/electron/sessionpage/sessionpage-main-build.mjs'
    );
    writeFileSync(join(outDir, 'chunk-AbCd1234.js'), 'exports.x = 1;\n');
    const ok = join(outDir, 'synthetic-chunked.js');
    writeFileSync(ok, 'const chunk = require("./chunk-AbCd1234.js");\n');
    expect(() => assertNoResidualRelativeRequires(ok)).not.toThrow();
  });

  it('still rejects a relative require whose target is missing even when other siblings exist', async () => {
    const { assertNoResidualRelativeRequires } = await import(
      '../../../apps/desktop/electron/sessionpage/sessionpage-main-build.mjs'
    );
    mkdirSync(join(outDir, 'impl'), { recursive: true });
    const bad = join(outDir, 'synthetic-half.js');
    writeFileSync(bad, 'require("./chunk-AbCd1234.js"); require("./impl/format");\n');
    expect(() => assertNoResidualRelativeRequires(bad)).toThrowError(/\.\/impl\/format/);
  });

  it('accepts the allowlisted vendor-optional native probe only', async () => {
    const { assertNoResidualRelativeRequires } = await import(
      '../../../apps/desktop/electron/sessionpage/sessionpage-main-build.mjs'
    );
    const ok = join(outDir, 'synthetic-allowlisted.js');
    writeFileSync(
      ok,
      'try { binding = require("./crypto/build/Release/sshcrypto.node"); } catch (err) {}\n',
    );
    expect(() => assertNoResidualRelativeRequires(ok)).not.toThrow();
  });

  it.each([
    'C:\\actions-runner-gugu\\_work\\gugu-dev\\gugu-dev\\apps\\desktop\\electron\\server\\server-boot.cjs',
    'C:/actions-runner-gugu/_work/gugu-dev/gugu-dev/apps/desktop/electron/server/server-boot.cjs',
    '/work/apps/desktop/electron/server/server-boot.cjs',
  ])('writes a reachable preload for the native external ID %s', async (externalId) => {
    const { build } = await import('vite');
    const { serverBootOutputPath, sessionpageResidualRequireGate } = await import(
      '../../../apps/desktop/electron/sessionpage/sessionpage-main-build.mjs'
    );
    const output = mkdtempSync(join(outDir, 'preload-'));
    const preload = 'exports.marker = "actual-preload";\n';
    const entry = join(output, 'entry.js');
    writeFileSync(entry, 'export { marker } from "./server-boot.cjs";');
    await build({
      configFile: false, logLevel: 'silent',
      plugins: [{
        name: 'native-preload-fixture',
        resolveId(id) {
          if (id === './server-boot.cjs') return { id: externalId, external: true };
        },
        generateBundle() { this.emitFile({ type: 'asset', fileName: 'server-boot.cjs', source: preload }); },
      }, sessionpageResidualRequireGate()],
      build: {
        outDir: output, emptyOutDir: false, minify: false,
        lib: { entry, formats: ['cjs'], fileName: () => 'server.js' },
        rollupOptions: { output: { paths: serverBootOutputPath } },
      },
    });
    expect(readFileSync(join(output, 'server-boot.cjs'), 'utf8')).toBe(preload);
    expect(readFileSync(join(output, 'server.js'), 'utf8')).not.toContain('C:');
    expect(createRequire(join(output, 'consumer.cjs'))('./server.js').marker).toBe('actual-preload');
    expect(serverBootOutputPath('other/server-boot.cjs.map')).toBe('other/server-boot.cjs.map');
  });
});

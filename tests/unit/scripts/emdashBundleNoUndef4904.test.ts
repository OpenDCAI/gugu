import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

describe('bundler-agnostic session bundle no-undef gate (#4904)', () => {
  const root = mkdtempSync(join(tmpdir(), 'emdash-no-undef-gate-'));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects the known requestMode-shaped undefined binding in a hashed Rollup chunk', async () => {
    const { assertNoUndefinedBindingsInEmdashBundles } = await import(
      '../../../scripts/build/verify-emdash-bundle-no-undef.mts'
    );
    const dist = join(root, 'rollup-dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(dist, 'emdash-main-bridge-BlfWFXRY.js'),
      '"use strict"; function requestMode() { (void 0 || (t = {})); }\n',
    );
    writeFileSync(join(dist, 'emdash-main-bridge.js'), '"use strict"; module.exports = require("./emdash-main-bridge-BlfWFXRY.js");\n');

    expect(() => assertNoUndefinedBindingsInEmdashBundles(dist)).toThrowError(/'t' is not defined/);
  });

  it('accepts the bridge stub and a declaration-safe CJS bridge', async () => {
    const { assertNoUndefinedBindingsInEmdashBundles } = await import(
      '../../../scripts/build/verify-emdash-bundle-no-undef.mts'
    );
    const dist = join(root, 'esbuild-dist');
    mkdirSync(join(dist, 'sessionpage'), { recursive: true });
    writeFileSync(join(dist, 'sessionpage', 'emdash-main-bridge.cjs'), '"use strict"; let t; t = {};\n');
    writeFileSync(join(dist, 'sessionpage', 'acp-runtime.js'), '"use strict"; const worker = {};\n');

    expect(() => assertNoUndefinedBindingsInEmdashBundles(dist)).not.toThrow();
  });
});

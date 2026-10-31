import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

describe('main.js static graph defers GUGU_HOME readers (@@@4865)', () => {
  const root = mkdtempSync(join(tmpdir(), 'main-static-graph-'));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function dist(name: string, files: Record<string, string>): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, source] of Object.entries(files)) writeFileSync(join(dir, file), source);
    return dir;
  }

  it('rejects a dependency manager reached through a static chunk require', async () => {
    const { assertMainStaticGraphDefersHomeReaders } = await import('../../../scripts/verify-main-static-graph.mts');
    const dir = dist('static', {
      'main.js': '"use strict";\nconst workspaceTransfer = require("./activity-ZfG87fjs.js");\n',
      'activity-ZfG87fjs.js': '"use strict";\nrequire("./registry-5u_C33RA.js");\n',
      'registry-5u_C33RA.js': '"use strict";\nensureUserBinDirsInPath();\nconst localDependencyManager = new HostDependencyManager();\n',
    });

    expect(() => assertMainStaticGraphDefersHomeReaders(dir)).toThrowError(/registry-5u_C33RA\.js/);
  });

  it('accepts the same chunk when main.js only reaches it through import()', async () => {
    const { assertMainStaticGraphDefersHomeReaders } = await import('../../../scripts/verify-main-static-graph.mts');
    const dir = dist('dynamic', {
      'main.js': '"use strict";\nconst schemas = require("./schemas-BJ6vfLQl.js");\nconst load = () => Promise.resolve().then(() => require("./dependency-managers-DebuKmkA.js"));\n',
      'schemas-BJ6vfLQl.js': '"use strict";\n',
      'dependency-managers-DebuKmkA.js': '"use strict";\nensureUserBinDirsInPath();\nconst localDependencyManager = new HostDependencyManager();\n',
    });

    expect(assertMainStaticGraphDefersHomeReaders(dir).files).toEqual(['main.js', 'schemas-BJ6vfLQl.js']);
  });
});

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/monaco/monaco-model-registry', () => ({
  modelRegistry: {
    bufferVersions: new Map<string, number>(),
    getText: (uri: string) => (uri.endsWith('.html') ? '<html><head><title>Q3 report</title></head></html>' : null),
    dirtyUris: new Set<string>(),
    toDiskUri: (uri: string) => uri.replace(/^file:\/\//, 'disk://'),
  },
}));

import { FileTabResource } from './file-tab-resource';

const ctx = {
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  modelRootPath: 'workspace:workspace-1',
};

/**
 * #5585: a file outside every workspace used to get no model at all, so every preview
 * had to decide for itself whether to ask the tab or Monaco — and two of the four got
 * it wrong. One address per tab is what removes that decision.
 */
describe('FileTabResource.bufferUri', () => {
  it('addresses a workspace file by「工作区 + 相对路径」', () => {
    const tab = new FileTabResource({ path: 'src/page.html' }, undefined, ctx);
    expect(tab.bufferUri).toBe('file:///workspace%3Aworkspace-1/src/page.html');
  });

  it('addresses a file outside the workspace under its own root, not the workspace one', () => {
    const tab = new FileTabResource(
      { path: '/Users/me/plan.html', isExternal: true },
      undefined,
      ctx
    );
    expect(tab.bufferUri).toBe('file:///external%3A/Users/me/plan.html');
  });

  it('leaves a text file outside the workspace to the registry rather than its own read', () => {
    const tab = new FileTabResource(
      { path: '/Users/me/plan.html', isExternal: true },
      undefined,
      ctx
    );
    // isLoading doubles as the「自己去取字节」switch FileContentPreview reads.
    expect(tab.isLoading).toBe(false);
  });

  it('still self-loads an image outside the workspace', () => {
    const tab = new FileTabResource(
      { path: '/Users/me/shot.png', isExternal: true },
      undefined,
      ctx
    );
    expect(tab.isLoading).toBe(true);
  });

  it('has no address at all without a model context', () => {
    const tab = new FileTabResource({ path: '/Users/me/plan.html', isExternal: true });
    expect(tab.bufferUri).toBe('');
    expect(tab.isDirty).toBe(false);
  });
});

// owner 10-06: an HTML tab is named by its <title> while it shows the page; editing the source, it is the file again (VS Code).
describe('FileTabResource.title', () => {
  it('is the page title in preview, and gives way to the file name in source view', () => {
    const tab = new FileTabResource({ path: '/w/r/report.html', isExternal: true }, undefined, ctx);
    expect(tab.viewMode).toBe('preview');
    expect(tab.title).toBe('Q3 report');
    tab.setViewMode('source');
    expect(tab.title).toBeNull();
  });

  it('is null for a file that is not HTML', () => {
    expect(new FileTabResource({ path: '/w/notes.md' }, undefined, ctx).title).toBeNull();
  });
});

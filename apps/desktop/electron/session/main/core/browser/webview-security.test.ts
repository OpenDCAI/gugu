import { describe, expect, it } from 'vitest';
import { isBrowserPartition, isPreviewPageUrl, validateBrowserPageMount } from './webview-security';

describe('#7274 browser page mount checks', () => {
  it('recognizes only session-page browser partitions', () => {
    expect(isBrowserPartition('persist:gugu-browser-profile')).toBe(true);
    expect(isBrowserPartition('persist:default')).toBe(false);
    expect(isBrowserPartition('temporary')).toBe(false);
  });

  it('requires registered browser partitions for a page', () => {
    const partition = 'persist:gugu-browser-project-workspace-task-browser';

    expect(
      validateBrowserPageMount({ partition, src: 'https://example.com' }, new Set([partition]))
    ).toEqual({
      ok: true,
      partition,
      url: 'https://example.com/',
    });
    expect(validateBrowserPageMount({ partition }, new Set())).toEqual({
      ok: false,
      reason: 'unregistered-partition',
    });
    expect(validateBrowserPageMount({}, new Set())).toEqual({
      ok: false,
      reason: 'missing-partition',
    });
  });

  it('blocks unsupported initial page URLs', () => {
    const partition = 'persist:gugu-browser-project-workspace-task-browser';

    expect(
      validateBrowserPageMount({ partition, src: 'javascript:alert(1)' }, new Set([partition]))
    ).toEqual({
      ok: false,
      reason: 'unsupported-url',
    });
    expect(
      validateBrowserPageMount(
        { partition, src: 'mailto: user@example.com' },
        new Set([partition])
      )
    ).toEqual({
      ok: false,
      reason: 'unsupported-url',
    });
  });
});

describe('page mount with a preview page', () => {
  const partition = 'persist:gugu-browser-profile';
  it('lets a browser tab attach straight onto a gugu-preview page (non-ASCII path included)', () => {
    const src = 'gugu-preview://8cdc746778ad4d64ac9963a172f6b473/demo-site/%E5%92%95.html';
    expect(validateBrowserPageMount({ src, partition }, new Set([partition]))).toEqual({ ok: true, partition, url: src });
  });

  it('still refuses other schemes and unregistered partitions', () => {
    expect(validateBrowserPageMount({ src: 'javascript:alert(1)', partition }, new Set([partition]))).toMatchObject({ ok: false });
    expect(
      validateBrowserPageMount({ src: 'gugu-preview://abc/x.html', partition }, new Set())
    ).toEqual({ ok: false, reason: 'unregistered-partition' });
    expect(isPreviewPageUrl('gugu-preview:///x.html')).toBe(false);
    expect(isPreviewPageUrl('https://example.com/')).toBe(false);
  });
});

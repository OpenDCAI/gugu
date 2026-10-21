// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fileBaseName, filePathKey } from '../stores/workspace-path';
import { fileTabLabels, htmlTitle } from './file-tab-label';

const tab = (path: string, title: string | null = null) => ({ path, title });

describe('fileTabLabels', () => {
  it('shows only the name when no other tab in the pane shares it', () => {
    expect(fileTabLabels([tab('/w/a/index.html'), tab('/w/b/notes.md')])).toEqual([
      { name: 'index.html' },
      { name: 'notes.md' },
    ]);
  });

  // owner 10-06: three report pages, all called index.html.
  it('adds the shortest parent path that tells same-named tabs apart', () => {
    expect(
      fileTabLabels([
        tab('/w/reports/omnisearch-ui/index.html'),
        tab('/w/reports/author-v2/index.html'),
        tab('/w/other/x/index.html'),
      ])
    ).toEqual([
      { name: 'index.html', hint: 'omnisearch-ui' },
      { name: 'index.html', hint: 'author-v2' },
      { name: 'index.html', hint: 'x' },
    ]);
  });

  it('walks further up only for the tabs whose nearest folder collides', () => {
    expect(
      fileTabLabels([tab('/w/a/x/index.html'), tab('/w/b/x/index.html'), tab('/w/c/y/index.html')]).map((l) => l.hint)
    ).toEqual(['a/x', 'b/x', 'y']);
  });

  it('names an HTML tab by its <title>, and tells equal titles apart by file name first', () => {
    expect(
      fileTabLabels([tab('/w/r/a.html', 'Report'), tab('/w/r/b.html', 'Report'), tab('/w/r/c.html', 'Other')])
    ).toEqual([
      { name: 'Report', hint: 'a.html' },
      { name: 'Report', hint: 'b.html' },
      { name: 'Other' },
    ]);
  });

  it('leaves alone what a path cannot tell apart: the same file twice (diff groups), a page with no path', () => {
    expect(fileTabLabels([tab('/w/src/a.ts'), tab('/w/src/a.ts')])).toEqual([{ name: 'a.ts' }, { name: 'a.ts' }]);
    expect(fileTabLabels([tab('', 'Vite App'), tab('', 'Vite App')])).toEqual([{ name: 'Vite App' }, { name: 'Vite App' }]);
  });

  it('splits a stored Windows path written with backslashes', () => {
    expect(fileTabLabels([tab('C:\\Users\\me\\a\\index.html'), tab('C:/Users/me/b/index.html')])).toEqual([
      { name: 'index.html', hint: 'a' },
      { name: 'index.html', hint: 'b' },
    ]);
  });
});

describe('fileBaseName', () => {
  it('takes the last segment whichever separator the path uses', () => {
    expect(fileBaseName('C:\\Users\\me\\index.html')).toBe('index.html');
    expect(fileBaseName('/Users/me/index.html')).toBe('index.html');
  });
});

describe('htmlTitle', () => {
  it('reads the page title the way a browser does', () => {
    expect(htmlTitle('<!doctype html><html><head><title>\n  Q3 &amp; Q4   report </title></head><body>x</body></html>')).toBe(
      'Q3 & Q4 report'
    );
  });

  it('only looks at the head end of the text: a <title> past the first 64 KB does not count', () => {
    expect(htmlTitle(`<html><head><style>${'x'.repeat(70 * 1024)}</style><title>late</title></head></html>`)).toBeNull();
  });

  it('is null without a title, or with an empty one', () => {
    expect(htmlTitle('<html><body><p>no title</p></body></html>')).toBeNull();
    expect(htmlTitle('<html><head><title>  </title></head></html>')).toBeNull();
  });
});

describe('filePathKey', () => {
  it('is the same key for both slash spellings and any casing of a Windows path', () => {
    const key = filePathKey('C:\\Users\\Me\\alpha\\index.html');
    expect(filePathKey('C:/Users/Me/alpha/index.html')).toBe(key);
    expect(filePathKey('c:/users/me/ALPHA/index.html')).toBe(key);
    expect(filePathKey('\\\\server\\share\\a.html')).toBe(filePathKey('//SERVER/share/A.html'));
  });

  it('keeps POSIX paths case-sensitive: on Linux those are two files', () => {
    expect(filePathKey('/home/me/Index.html')).not.toBe(filePathKey('/home/me/index.html'));
  });
});

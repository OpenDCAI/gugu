import { describe, expect, it } from 'vitest';
import { fileSuffixOf, savedFileName, typedFileName } from './app-runtime-protocol';

describe('the name a chat-folder file is saved under', () => {
  it.each([
    ['周报', 'text/markdown', '周报.md'],
    ['投票', 'application/json', '投票.json'],
    ['friday.vote.json', 'application/json', 'friday.vote.json'],
    ['rows.csv', 'application/json', 'rows.csv.json'],
    ['栖页 2.0 发布页', 'text/markdown', '栖页 2.0 发布页.md'],
    ['a.jpeg', 'image/jpeg', 'a.jpeg'],
    ['PHOTO.JPEG', 'image/jpeg', 'PHOTO.JPEG'],
    ['photo', 'image/jpeg', 'photo.jpg'],
    ['截图.v2', 'image/png', '截图.v2.png'],
    ['报告', 'application/pdf', '报告.pdf'],
    ['报告.final', 'application/pdf', '报告.final.pdf'],
    ['报告', 'Application/PDF; charset=binary', '报告.pdf'],
    ['notes', 'text/plain', 'notes.txt'],
    ['table', 'text/csv', 'table.csv'],
    ['page', 'text/html', 'page.html'],
    ['x', 'application/octet-stream', 'x'],
    ['archive.v2', 'application/octet-stream', 'archive.v2'],
    ['x', 'application/unknown', 'x'],
    ['x', undefined, 'x'],
  ])('%s (%s) saves as %s', (name, contentType, expected) => {
    expect(savedFileName({ name, contentType })).toBe(expected);
  });

  it('leaves opener matching unchanged for stored bytes with a bare name', () => {
    const file = { name: '报告', contentType: 'application/pdf' };
    expect(fileSuffixOf(file)).toBe('');
    expect(typedFileName(file)).toBe('报告');
    expect(savedFileName(file)).toBe('报告.pdf');
  });
});

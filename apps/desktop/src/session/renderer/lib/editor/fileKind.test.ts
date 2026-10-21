import { describe, expect, it } from 'vitest';
import { attachmentOpenTarget } from '@renderer/features/sessions/stores/attachment-open-target';
import { getFileKind, isBinaryForDiff, isOfficeKind, isSelfLoadingKind } from './fileKind';

/**
 * #7191 owner 2026-10-15:会话页点开 Office 文件「咕咕里预览」。
 * 之前 .xlsx/.docx/.pptx 不在任何一张表里 → 被判成 text → 读出二进制 → 一张没按钮的「不支持的文件格式」;
 * 工作区外的附件同理(它靠同一张表决定要不要交给系统)。
 */
describe('#7191 Office 文件的种类', () => {
  it.each([
    ['报表.xlsx', 'xlsx'],
    ['带宏.XLSM', 'xlsx'],
    ['合同.docx', 'docx'],
    ['汇报.pptx', 'pptx'],
  ] as const)('%s → %s,自己取字节、只读预览', (path, kind) => {
    expect(getFileKind(`/Users/me/${path}`)).toBe(kind);
    expect(isOfficeKind(kind)).toBe(true);
    expect(isSelfLoadingKind(kind)).toBe(true);
  });

  it.each(['旧表.xls', '旧文档.doc', '旧幻灯片.ppt', '表.ods', '表.numbers'])(
    '%s 画不出来:归二进制(占位卡带「用系统默认程序打开」;附件直接交给系统)',
    (path) => {
      expect(getFileKind(path)).toBe('binary');
      expect(attachmentOpenTarget(path)).toBe('system');
    }
  );

  it('Office 附件开在会话页的页签里,不再被推给系统也不再落到占位卡', () => {
    for (const path of ['/tmp/a.xlsx', '/tmp/b.docx', '/tmp/c.pptx']) expect(attachmentOpenTarget(path)).toBe('editor');
  });

  it('差异视图里 Office 文件按二进制处理(❌ 当文本塞进 Monaco)', () => {
    expect(isBinaryForDiff('a.xlsx')).toBe(true);
    expect(isBinaryForDiff('a.docx')).toBe(true);
    expect(isBinaryForDiff('a.ts')).toBe(false);
  });

  it('.key 仍按文本打开:PEM 私钥(server.key)是纯文本,不能为 Keynote 把它们变成打不开的二进制', () => {
    expect(getFileKind('/etc/ssl/server.key')).toBe('text');
    expect(isBinaryForDiff('server.key')).toBe(false);
  });

  it('原型链上的名字不会被当成 Office 扩展名', () => {
    expect(getFileKind('weird.constructor')).toBe('text');
    expect(getFileKind('weird.tostring')).toBe('text');
  });
});

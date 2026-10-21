import { describe, expect, it } from 'vitest';
import {
  previewPathname,
  previewRootFor,
  previewUrl,
  resolvePreviewRequest,
} from './preview-url';

/**
 * 这一份测的是**围栏**,不是字符串拼接。
 *
 * 它替掉的是内联器那 200 行:那些用例逐个盯「CSS 内联对不对、srcset 改写对不对、@import 报没报」——
 * 全是在验我们重写的那份 URL 解析。现在那份解析归浏览器,留下来要守的只剩一条:
 * **哪些路径允许被这份预览取到。**
 */

const WS = '/Users/me/proj';

describe('文档在工作区里:围栏是工作区根', () => {
  const root = previewRootFor(WS, `${WS}/docs/index.html`);

  it('文档地址是相对工作区根的那一段', () => {
    expect(root.kind).toBe('workspace');
    expect(previewPathname(root, `${WS}/docs/index.html`)).toBe('/docs/index.html');
  });

  it('相对路径按 URL 规则落回本机路径', () => {
    expect(resolvePreviewRequest(root, '/docs/style.css')).toBe(`${WS}/docs/style.css`);
    expect(resolvePreviewRequest(root, '/assets/logo.png')).toBe(`${WS}/assets/logo.png`);
  });

  it('`/` 开头指到工作区根 —— 与换协议之前同一条规则', () => {
    expect(resolvePreviewRequest(root, '/style.css')).toBe(`${WS}/style.css`);
  });

  it('爬出工作区的一律拒,❌ 不退回去读一个「差不多」的路径', () => {
    expect(resolvePreviewRequest(root, '/../secrets.txt')).toBeNull();
    expect(resolvePreviewRequest(root, '/docs/../../secrets.txt')).toBeNull();
    expect(resolvePreviewRequest(root, '/../../../../etc/passwd')).toBeNull();
  });

  it('工作区内的 `..` 照常归一化', () => {
    expect(resolvePreviewRequest(root, '/docs/../assets/a.png')).toBe(`${WS}/assets/a.png`);
  });
});

describe('文档在工作区外:放行本机绝对路径', () => {
  const root = previewRootFor(WS, '/Users/me/Desktop/report.html');

  it('圈外的文档不套工作区围栏(#5814:别把用户自己的文件挡在他自己眼前)', () => {
    expect(root.kind).toBe('machine');
    expect(previewPathname(root, '/Users/me/Desktop/report.html')).toBe(
      '/Users/me/Desktop/report.html'
    );
    expect(resolvePreviewRequest(root, '/Users/me/Desktop/chart.png')).toBe(
      '/Users/me/Desktop/chart.png'
    );
  });

  it('爬到根之上仍然是不合法的路径', () => {
    expect(resolvePreviewRequest(root, '/../..')).toBeNull();
  });

  it('Windows 盘符留在 pathname 里,跨盘引用不丢', () => {
    const winRoot = previewRootFor('C:/proj', 'D:/notes/report.html');
    expect(winRoot.kind).toBe('machine');
    expect(previewPathname(winRoot, 'D:/notes/report.html')).toBe('/D:/notes/report.html');
    expect(resolvePreviewRequest(winRoot, '/C:/shared/logo.png')).toBe('C:/shared/logo.png');
  });
});

describe('工作区还没就位', () => {
  it('按圈外处理 —— 判断不了就别猜,猜成圈里会把整份文档连同资源一起挡掉', () => {
    expect(previewRootFor(undefined, '/Users/me/a.html').kind).toBe('machine');
  });
});

describe('地址本身', () => {
  it('host 是这次预览的 id,所以两份预览天然不同源', () => {
    const root = previewRootFor(WS, `${WS}/a.html`);
    expect(previewUrl('abc123', root, `${WS}/a.html`)).toBe('gugu-preview://abc123/a.html');
  });

  it('路径里的空格与中文按 URL 编码,取回来时还原得回去', () => {
    const root = previewRootFor(WS, `${WS}/我的 报告.html`);
    const url = previewUrl('abc123', root, `${WS}/我的 报告.html`);
    expect(url).not.toBeNull();
    const pathname = new URL(url as string).pathname;
    expect(resolvePreviewRequest(root, pathname)).toBe(`${WS}/我的 报告.html`);
  });
});

import { describe, expect, it } from 'vitest';
import { touchesPageAssets } from './page-assets';

describe('页面引用的文件变了 → 重载一次(touchesPageAssets)', () => {
  const page = '/w/site/index.html';

  it('同目录或子目录下的样式 / 脚本 / 图片变了:算', () => {
    expect(touchesPageAssets(page, ['/w/site/style.css'])).toBe(true);
    expect(touchesPageAssets(page, ['/w/site/js/app.mjs'])).toBe(true);
    expect(touchesPageAssets(page, ['/w/site/img/logo.PNG'])).toBe(true);
    expect(touchesPageAssets(page, ['/w/site/other.html'])).toBe(true);
  });

  it('不是页面资源的文件、页面目录之外的文件:不算', () => {
    expect(touchesPageAssets(page, ['/w/site/notes.txt'])).toBe(false);
    expect(touchesPageAssets(page, ['/w/site/app.ts'])).toBe(false);
    expect(touchesPageAssets(page, ['/w/other/style.css'])).toBe(false);
    expect(touchesPageAssets(page, ['/w/style.css'])).toBe(false);
    expect(touchesPageAssets(page, ['/w/site-old/style.css'])).toBe(false);
    expect(touchesPageAssets(page, [])).toBe(false);
  });

  it('页面自己变了:只有 includePage 时才算(文件页签的预览看缓冲区,不算)', () => {
    expect(touchesPageAssets(page, [page])).toBe(false);
    expect(touchesPageAssets(page, [page], true)).toBe(true);
    expect(touchesPageAssets(page, [page, '/w/site/a.css'])).toBe(true);
  });

  it('Windows 分隔符两边都认', () => {
    expect(touchesPageAssets('C:\\w\\site\\index.html', ['C:\\w\\site\\a.css'])).toBe(true);
    expect(touchesPageAssets('C:\\w\\site\\index.html', ['C:/w/site/index.html'], true)).toBe(true);
  });

  it('没有目录的页面路径:只认页面自己', () => {
    expect(touchesPageAssets('index.html', ['style.css'])).toBe(false);
    expect(touchesPageAssets('index.html', ['index.html'], true)).toBe(true);
  });
});

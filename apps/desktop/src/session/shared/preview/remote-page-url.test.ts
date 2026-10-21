import { describe, expect, it } from 'vitest';
import { resolvePreviewRequest } from './preview-url';
import {
  fileUrlToMachinePath,
  machinePathToFileUrl,
  remotePageLoadUrl,
  remotePagePresentUrl,
  remotePageRoot,
} from './remote-page-url';

const ROOT = '/root/proj';
const ID = 'abc123';

describe('file: 地址 ↔ 那台机器上的路径', () => {
  it('POSIX 路径原样,编码的字符解开', () => {
    expect(fileUrlToMachinePath('file:///root/proj/my%20page.html')).toBe('/root/proj/my page.html');
    expect(fileUrlToMachinePath('file:///root/proj/x.html?a=1#top')).toBe('/root/proj/x.html');
    expect(fileUrlToMachinePath('file://localhost/root/x.html')).toBe('/root/x.html');
  });

  it('不是 file:、带了别的主机、解不开 ⇒ null', () => {
    expect(fileUrlToMachinePath('https://example.com/x.html')).toBeNull();
    expect(fileUrlToMachinePath('file://other-host/x.html')).toBeNull();
    expect(fileUrlToMachinePath('not a url')).toBeNull();
  });

  it('路径 → file: 地址,往返一致', () => {
    const url = machinePathToFileUrl('/root/proj/my page#1.html');
    expect(url).toBe('file:///root/proj/my%20page%231.html');
    expect(fileUrlToMachinePath(url!)).toBe('/root/proj/my page#1.html');
    expect(machinePathToFileUrl('relative/x.html')).toBeNull();
  });
});

describe('页签加载的地址:围栏是会话工作目录', () => {
  it('工作目录里的页面 → 这一格自己的 gugu-preview 地址(查询串与锚点保留)', () => {
    expect(remotePageLoadUrl(ID, ROOT, 'file:///root/proj/site/index.html?x=1#s')).toBe(
      'gugu-preview://abc123/site/index.html?x=1#s'
    );
    // 根目录末尾的斜杠不影响
    expect(remotePageLoadUrl(ID, '/root/proj/', 'file:///root/proj/a.html')).toBe('gugu-preview://abc123/a.html');
  });

  it('工作目录外 / 用 .. 爬出去 / 前缀相同的兄弟目录 ⇒ null(❌ 开出一个取不到的页面)', () => {
    expect(remotePageLoadUrl(ID, ROOT, 'file:///root/.ssh/id_rsa')).toBeNull();
    expect(remotePageLoadUrl(ID, ROOT, 'file:///root/proj/../.ssh/config')).toBeNull();
    expect(remotePageLoadUrl(ID, ROOT, 'file:///root/project-other/x.html')).toBeNull();
    expect(remotePageLoadUrl(ID, ROOT, 'file:///etc/passwd')).toBeNull();
  });

  it('不是 file: 地址 ⇒ null(localhost 端口与公网地址走别的路)', () => {
    expect(remotePageLoadUrl(ID, ROOT, 'http://localhost:3000/')).toBeNull();
    expect(remotePageLoadUrl(ID, 'relative', 'file:///root/proj/a.html')).toBeNull();
  });

  it('页面里的相对资源落回工作目录;爬出根的请求在协议那头被围栏拒掉', () => {
    const fence = remotePageRoot(ROOT)!;
    expect(resolvePreviewRequest(fence, '/site/style.css')).toBe('/root/proj/site/style.css');
    expect(resolvePreviewRequest(fence, '/../.ssh/id_rsa')).toBeNull();
    expect(resolvePreviewRequest(fence, '/%2e%2e/.ssh/id_rsa')).toBeNull();
  });
});

describe('地址栏显示的地址', () => {
  it('这一格的预览地址 → 人要开的那个 file: 地址', () => {
    expect(remotePagePresentUrl(ID, ROOT, 'gugu-preview://abc123/site/index.html?x=1#s')).toBe(
      'file:///root/proj/site/index.html?x=1#s'
    );
    // 页面里点到同目录的另一页:照样换回 file:
    expect(remotePagePresentUrl(ID, ROOT, 'gugu-preview://abc123/other%20page.html')).toBe(
      'file:///root/proj/other%20page.html'
    );
  });

  it('别的地址原样显示(null):外链、别的预览、解析不了的', () => {
    expect(remotePagePresentUrl(ID, ROOT, 'https://example.com/')).toBeNull();
    expect(remotePagePresentUrl(ID, ROOT, 'gugu-preview://zzz999/a.html')).toBeNull();
    expect(remotePagePresentUrl(ID, ROOT, 'about:blank')).toBeNull();
  });

  it('加载地址与显示地址互为逆', () => {
    const file = 'file:///root/proj/a%20b/c.html#x';
    expect(remotePagePresentUrl(ID, ROOT, remotePageLoadUrl(ID, ROOT, file)!)).toBe(file);
  });
});

// d22 实机:会话目录是 /root/.config/咕咕/task-home(非 ASCII),server 回来的地址是编码过的。
describe('非 ASCII 的会话目录', () => {
  const root = '/root/.config/咕咕/task-home';
  const served = 'file:///root/.config/%E5%92%95%E5%92%95/task-home/demo-site/index.html';

  it('编码过的 file: 地址解回那台机器上的路径,并排进这一格的预览地址', () => {
    expect(fileUrlToMachinePath(served)).toBe('/root/.config/咕咕/task-home/demo-site/index.html');
    expect(remotePageLoadUrl(ID, root, served)).toBe('gugu-preview://abc123/demo-site/index.html');
    expect(remotePageLoadUrl(ID, root, 'file:///root/.config/咕咕/task-home/页面/首页.html')).toBe(
      'gugu-preview://abc123/%E9%A1%B5%E9%9D%A2/%E9%A6%96%E9%A1%B5.html'
    );
  });

  it('地址栏换回的地址与 server 给的同一个', () => {
    expect(remotePagePresentUrl(ID, root, 'gugu-preview://abc123/demo-site/index.html')).toBe(served);
  });
});


import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: {} }, events: { on: () => () => {} } }));
// The 「给哪些 agent」 section reaches the window-bound platform layer; these pages are about the page's own words.
vi.mock('./app-given-section', () => ({ AppGivenSection: () => null }));

const { AppProductPage, splitReadme } = await import('./app-product-page');
const { manifestLanguages } = await import('@shared/extensions/catalog');

const readmeOf = (readme: string | null) => ({
  marketReadme: vi.fn(async () => ({ success: true, data: { readme } })),
  marketHistory: vi.fn(async () => ({ success: true, data: [] })),
});
// Keys and their parameters stay readable in the rendered text.
const translate = ((key: string, params?: Record<string, string>) =>
  params ? `${key}(${Object.values(params).join('|')})` : key) as never;

const pomodoro = {
  id: 'pomodoro-log',
  name: 'Pomodoro',
  version: '1.2.0',
  permissions: { capabilities: ['agents:tools'] },
  contributes: { tabs: [], mcpServers: [{ name: 'pomodoro', command: 'node', args: ['mcp/server.mjs'] }] },
} as never;

async function render(props: Record<string, unknown>, act_?: (document: Document) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'navigator', 'getComputedStyle'] as const) {
    vi.stubGlobal(key, key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key]);
  }
  const root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
  await act(async () => {
    root.render(
      React.createElement(AppProductPage, {
        subject: { manifest: pomodoro, installed: pomodoro, installRef: undefined, cloud: null },
        enabled: true,
        lifecycle: null,
        locale: 'en',
        translate,
        api: readmeOf(null) as never,
        onBack: () => undefined,
        onLifecycle: () => undefined,
        onInstallVersion: () => undefined,
        menu: {},
        ...props,
      } as never)
    );
  });
  const document = dom.window.document;
  const text = document.body.textContent ?? '';
  if (act_) await act_(document);
  const fieldset = document.querySelector('[data-testid="extension-detail-actions"]') as HTMLFieldSetElement;
  const fieldsetDisabled = fieldset.disabled;
  const buttonsDisabled = [...fieldset.querySelectorAll('button')].map((button) => button.matches(':disabled'));
  const back = document.querySelector('[data-testid="app-product-back"]') as HTMLButtonElement;
  const backDisabled = back.matches(':disabled');
  act(() => root.unmount());
  vi.unstubAllGlobals();
  return { text, fieldsetDisabled, buttonsDisabled, backDisabled };
}

describe('App 的产品页 (#7059)', () => {
  it('「给 agent 工具」那句带上要跑的命令,与同意框同一句', async () => {
    expect((await render({})).text).toContain('node mcp/server.mjs');
  });

  it('发布方是 manifest 写的作者(市场上的也一样,❌ 一律写官方);没写作者的写「本地文件夹」', async () => {
    const source = { repo: 'shuxueshuxue/promo-skills', path: '.', commit: '6f46446' + 'a'.repeat(33) };
    const fromMarket = (manifest: unknown) => ({ subject: { manifest, installed: undefined, installRef: { extensionId: 'pomodoro-log', version: '1.2.0' }, cloud: { source, version: '1.2.0' } } });
    const authored = { ...(pomodoro as object), author: 'SpexCode' };
    const page = await render(fromMarket(authored));
    expect(page.text).toContain('SpexCode');
    expect(page.text).not.toContain('extensions.official');
    expect((await render(fromMarket(pomodoro))).text).toContain('extensions.publisherLocal');
  });

  it('安装数:给了就是数据带的第一格;读不到(null)就没有这一格,❌ 写 0', async () => {
    const strip = async (installs: string | null) => {
      let cells: string[] = [];
      await render({ installs }, async (document) => {
        cells = [...document.querySelectorAll('[data-testid="app-product-strip"] dt')].map((node) => node.textContent ?? '');
      });
      return cells;
    };
    expect((await strip('10+'))[0]).toBe('extensions.installsCaption');
    expect(await strip(null)).not.toContain('extensions.installsCaption');
  });

  it('「用在哪」照 manifest 的声明一项一句,次序 任务侧栏 → Agent 工具 → 群组', async () => {
    const papers = {
      ...(pomodoro as object),
      id: 'paper-club',
      permissions: { capabilities: ['agents:tools', 'chat:read'] },
      contributes: {
        tabs: [{ name: 'shelf', title: 'Papers' }, { name: 'reader', title: 'Papers', opensFiles: { chat: ['.pdf', '.paper.json'] } }],
        mcpServers: [{ tools: 'tools.js' }],
        skills: 'skills',
      },
    };
    let uses: string[] = [];
    await render({ subject: { manifest: papers, installed: undefined, installRef: undefined, cloud: null } }, async (document) => {
      uses = [...document.querySelectorAll('[data-testid="app-product-uses"] li')].map((node) => node.textContent ?? '');
    });
    expect(uses).toEqual(['extensions.useTaskTab(Papers)', 'extensions.useAgentToolsSkills', 'extensions.useGroupFiles(extensions.fileKind.pdf)']);
  });

  it('市场有来源时显示「查看源码」,仓、提交和目录只在悬停提示里;没有来源记录的旧版本不写', async () => {
    const source = { repo: 'shuxueshuxue/promo-skills', path: '.', commit: '6f46446' + 'a'.repeat(33) };
    const subject = (cloud: unknown) => ({ subject: { manifest: pomodoro, installed: pomodoro, installRef: undefined, cloud } });
    for (const path of ['.', 'app']) {
      const page = await render(subject({ source: { ...source, path } }), async (document) => {
        const button = document.querySelector('[data-testid="app-product-review"] button')!;
        expect(button.textContent).toBe('extensions.viewSource');
        expect(button.getAttribute('title')).toBe(`shuxueshuxue/promo-skills @ 6f46446${path === '.' ? '' : ' · app'}`);
        expect(button.classList.contains('mk-mono')).toBe(false);
      });
      expect(page.text).not.toContain('shuxueshuxue/promo-skills');
    }
    expect((await render(subject({ source: null }))).text).not.toContain('extensions.viewSource');
  });

  it('头上那颗按钮:能打开就写「打开」,按了交给屏幕去开;没有可开的就不画', async () => {
    let opened = 0;
    const clickAction = async (document: Document) => {
      const button = document.querySelector('[data-testid="app-product-action"]') as HTMLButtonElement | null;
      if (button) await act(async () => void button.dispatchEvent(new document.defaultView!.MouseEvent('click', { bubbles: true })));
    };
    const shown = await render({ lifecycle: { kind: 'open' }, onLifecycle: () => (opened += 1) }, clickAction);
    expect(shown.text).toContain('extensions.open');
    expect(opened).toBe(1);
    expect((await render({ lifecycle: null })).text).not.toContain('extensions.open');
  });

  it('那台机器离线 / 太旧(#6264):装、卸、收回、装某一版一起灰,「‹ App」照样能回去', async () => {
    const off = await render({ readOnly: true, lifecycle: { kind: 'get' }, onTogglePermission: () => undefined });
    expect(off.fieldsetDisabled).toBe(true);
    expect(off.buttonsDisabled.length).toBeGreaterThan(0);
    expect(off.buttonsDisabled.every(Boolean)).toBe(true);
    expect(off.backDisabled).toBe(false);
    expect((await render({ readOnly: false })).fieldsetDisabled).toBe(false);
  });

  it('权限分「它能看 / 它能做」,装着的每项能单独收回;收回的那项划掉、写「恢复」', async () => {
    const notes = {
      ...(pomodoro as object),
      id: 'agent-notes',
      permissions: { capabilities: ['agents:read:all', 'notifications'], network: ['example.com'] },
    } as never;
    const { text } = await render({
      subject: { manifest: notes, installed: notes, installRef: undefined, cloud: null },
      revoked: ['notifications'],
      onTogglePermission: () => undefined,
    });
    expect(text).toContain('extensions.permissionsSee');
    expect(text).toContain('extensions.permissionsDo');
    expect(text).toContain('extensions.restore');
    expect(text).toContain('extensions.revoke');
    expect(text).toContain('extensions.permissionsWithdrawnNote(3|1)');
  });

  it('「对 agent 说」:manifest 写了示例就画出来,点一句交给屏幕去新建任务', async () => {
    const asked: string[] = [];
    const withExamples = { ...(pomodoro as object), examples: ['把刚才查到的三个结论记进随手记'] } as never;
    const { text } = await render(
      { subject: { manifest: withExamples, installed: undefined, installRef: undefined, cloud: null }, onAsk: (line: string) => asked.push(line) },
      async (document) => {
        const ask = document.querySelector('.mk-ask') as HTMLButtonElement;
        await act(async () => void ask.dispatchEvent(new document.defaultView!.MouseEvent('click', { bubbles: true })));
      }
    );
    expect(text).toContain('extensions.askAgent');
    expect(asked).toEqual(['把刚才查到的三个结论记进随手记']);
  });
});

describe('产品页的语言与去重', () => {
  const office = {
    ...(pomodoro as object),
    id: 'office',
    name: '咕咕办公',
    description: 'Base text, written once.',
    localized: { zh: { name: '咕咕办公', description: '中文简介。' }, en: { name: 'Gugu Office', description: 'English blurb.' } },
    contributes: { tabs: [], skills: 'skills' },
  } as never;
  const subject = (manifest: unknown) => ({ subject: { manifest, installed: undefined, installRef: undefined, cloud: null } });

  it('「关于」写界面语言的那句简介,README 正文不进页面(在 → 打开的框里)', async () => {
    const readme = '# 咕咕办公\n\nREADME body in one language only.';
    const { text } = await render({ ...subject(office), api: readmeOf(readme) as never });
    expect(text).toContain('Gugu Office');
    expect(text).toContain('English blurb.');
    expect(text).not.toContain('README body');
  });

  it('manifest 写了别的语言才有切换;点「中文」名字和简介一起换', async () => {
    let after = '';
    const { text } = await render(subject(office), async (document) => {
      const items = [...document.querySelectorAll('[data-testid="app-product-language"] button')] as HTMLButtonElement[];
      expect(items.map((item) => item.textContent)).toEqual(['English', '中文']);
      await act(async () => void items[1]!.dispatchEvent(new document.defaultView!.MouseEvent('click', { bubbles: true })));
      after = document.body.textContent ?? '';
    });
    expect(text).toContain('English blurb.');
    expect(after).toContain('中文简介。');
    expect(after).not.toContain('English blurb.');
    // 只写了一种语言(或没写):没得换,❌ 画一个只有一格的切换。
    let single = 0;
    await render(subject(pomodoro), async (document) => void (single = document.querySelectorAll('[data-testid="app-product-language"]').length));
    expect(single).toBe(0);
  });

  it('同名的几个页签一行;带程序又带技能说明的,说明跟在工具那一行里,❌ 单起一行', async () => {
    const tabs = {
      ...(pomodoro as object),
      contributes: {
        tabs: [
          { name: 'a', title: 'Office', opensFiles: { chat: ['.pptx'] } },
          { name: 'b', title: 'Office' },
        ],
        skills: 'skills',
        mcpServers: [{ name: 'pomodoro', command: 'node', args: ['mcp/server.mjs'] }],
      },
    } as never;
    const { text } = await render(subject(tabs));
    expect(text.split('extensions.addsTabTitle(Office)').length - 1).toBe(1);
    expect(text).toContain('extensions.addsTabOpens(.pptx)');
    expect(text).toContain('extensions.addsTabPlain');
    // 技能说明只出现那一句(从前还单起一行,名目 extensions.addsSkills)。
    expect(text.split('extensions.addsSkills').length - 1).toBe(1);
    expect(text).toContain('extensions.addsSkillsText');
  });
});

describe('manifestLanguages', () => {
  it('界面语言写了就用它打头;没写的那格是原文(不冠语言名);同一语言的几个键只算一种', () => {
    const both = { localized: { 'zh-CN': {}, zh: {}, en: {} } };
    expect(manifestLanguages(both, 'en-US')).toEqual([
      { locale: 'en', language: 'en' },
      { locale: 'zh-CN', language: 'zh' },
    ]);
    expect(manifestLanguages({ localized: { 'zh-CN': {} } }, 'en-US')).toEqual([
      { locale: 'en-US', language: null },
      { locale: 'zh-CN', language: 'zh' },
    ]);
    expect(manifestLanguages({ localized: { 'zh-CN': {} } }, 'zh-CN')).toHaveLength(1);
    expect(manifestLanguages({}, 'zh-CN')).toEqual([{ locale: 'zh-CN', language: null }]);
  });
});

describe('README 拆成截图和正文 (#7059)', () => {
  it('图片(markdown 与 <img>)进预览,正文里不再画;开头的一级标题(就是名字)去掉;相对路径的图不要', () => {
    const { images, text } = splitReadme(
      '# 随手记\n\n你和 agent 共用的一本随手记。\n\n![随手记页签](https://download.example/market/media/a.png)\n\n<img src="https://download.example/b.png" alt="第二张">\n\n![本地](shot.png)\n\n## 用法\n点一条。'
    );
    expect(images).toEqual([
      { src: 'https://download.example/market/media/a.png', alt: '随手记页签' },
      { src: 'https://download.example/b.png', alt: '第二张' },
    ]);
    expect(text).not.toContain('# 随手记\n');
    expect(text).not.toContain('a.png');
    expect(text).toContain('你和 agent 共用的一本随手记。');
    expect(text).toContain('## 用法');
  });
});

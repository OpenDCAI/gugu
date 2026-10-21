/**
 * #6908 手机上的弹层(Sheet)放不下时,得有一块能滚,该点的都点得到。手机视口、真 Chromium、真 CSS、真组件,数据换成长的:
 *   · 看电脑会话的选项抽屉,25 个模型(owner 10-02「选模型那个……没法上下滑动」);
 *   · 群成员资料卡,995 字简介 + 群主的管理块;
 *   · 好友 / 入群申请详情,60 行附言;
 *   · 从别的 App 分享 30 个文件进来的「发送到」页。
 * 10-07(owner「手机端创建新 agent……那些设置经常超出竖直长度,又没有滚动条」):放不下的部分改由 Sheet 自己滚
 * (sheetMotion.ts @@@sheet-scroll),❌ 再由调用方各自指定滚动区。新增两格:
 *   · 任意一张手机抽屉,内容里没有任何滚动区,也能滚到最后一行;
 *   · 新建会话的选项抽屉,12 个项目:项目列表不被压扁,在设置行上滚得动,滚到最后一项设置,头部一直在顶上。
 * 判滚动只用真滚轮(userEvent.wheel → page.mouse.wheel)。❌ 改 scrollTop:脚本连 overflow:hidden 的盒子也滚得动,人滚不动。
 */
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { SessionOptionsPill } from '@/mobile/agent-watch/SessionOptionsPill';
import { CreateOptionsPill } from '@/mobile/agent-watch/CreateOptionsPill';
import { Sheet } from '@/components/ui/Sheet';
import { MemberProfilePopover } from '@/components/MemberProfilePopover';
import { RequestDetailSheet } from '@/components/requests/RequestDetailSheet';
import { ShareIntakeContent } from '@/mobile/share-intake/ShareIntakeSheet';
import type { MemberProfileCardModel } from '@/components/MemberProfileCard';
import type { ChatItem } from '@gugu/core/shared/types/chat';
import '@/i18n';
import '@/styles/tokens.css';
import '@/mobile/agent-watch/agent-watch.css';

vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => {
  const group = (ids: string[]) => ({ selected: ids[0], available: ids.map((id) => ({ id, name: id, description: `${id} · description` })) });
  const options = { model: group(Array.from({ length: 25 }, (_, i) => `model-${i + 1}`)), mode: group(['default', 'plan']), effort: group(['low', 'high']) };
  return { SessionpageRpcError: class extends Error {}, fetchSessionOptions: async () => options, setSessionOption: async () => options, reloadSessionModel: async () => options };
});
// 资料卡、申请详情、发送到页经 lib/supabase 在加载时就建客户端,没有地址会当场抛;浏览器 project 没有 guguTestEnv,这里不连网,给个假地址。
vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
const { CHAT } = vi.hoisted(() => ({
  CHAT: { id: 'chat-1', kind: 'group', name: '长简介', peer_user_id: null, avatar: null, member_user_ids: [], last_message_at: '2026-10-05T00:00:00Z', created_at: '2026-10-05T00:00:00Z', unread_count: 0, is_pinned: false } as unknown as ChatItem,
}));
vi.mock('@/store/chatContext', async (original) => ({
  ...(await original<object>()),
  useChatStore: () => ({ chats: [CHAT], identitiesById: {}, activeChatId: null, drafts: {}, draftAttachments: {}, setDraft: () => {}, setDraftAttachments: () => {} }),
}));
vi.mock('@/store/auth', async (original) => ({ ...(await original<object>()), useAuth: () => ({ user: { id: 'owner', bio: null, email: null } }) }));
vi.mock('@/store/contactsContext', async (original) => ({ ...(await original<object>()), useContactsStore: () => ({ contacts: [], updateContactAlias: async () => {} }) }));
vi.mock('@/hooks/useAgentDisplayStatus', async (original) => ({ ...(await original<object>()), useAgentDisplayStatus: () => ({ presence: { presentation: null } }) }));

let root: Root | null = null;
beforeEach(() => page.viewport(412, 842));
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
});
const mount = (node: ReactNode) => {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  root.render(node);
};
const sheet = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const inside = (el: Element, box: HTMLElement) => el.getBoundingClientRect().top >= box.getBoundingClientRect().top - 1 && el.getBoundingClientRect().bottom <= box.getBoundingClientRect().bottom + 1;

it('agent-watch options: the model sheet scrolls to its last model, the other settings keep their full height', async () => {
  mount(<SessionOptionsPill deviceId="device" sessionId="conversation" busy={false} />);
  await userEvent.click(page.getByTestId('agent-watch-options-open'));
  const rows = () => document.querySelectorAll('[data-testid="agent-watch-options"] .gg-aw-choice-group [role="radio"]');
  await until('25 models in the sheet', () => rows().length === 25);
  const box = sheet('agent-watch-options')!;
  const summary = box.querySelector<HTMLElement>('.gg-aw-summary-group')!;
  expect.soft(summary.clientHeight, 'the other settings keep their full height').toBe(summary.scrollHeight);
  const last = rows()[24]!;
  await userEvent.wheel(box.querySelector('.gg-aw-choice-group')!, { delta: { y: 400 }, times: 10 });
  await until('the last model is inside the sheet', () => last.getBoundingClientRect().bottom <= box.getBoundingClientRect().bottom);
});

it('any sheet: content with no scroll area of its own still scrolls to its last row', async () => {
  mount(
    <Sheet onClose={() => {}} mobileFitContent testId="plain-sheet">
      <div>{Array.from({ length: 40 }, (_, i) => <div key={i} style={{ height: 48 }}>row {i + 1}</div>)}</div>
    </Sheet>,
  );
  await until('the sheet is open', () => sheet('plain-sheet') != null);
  const box = sheet('plain-sheet')!;
  const last = [...box.querySelectorAll('div')].find((el) => el.textContent === 'row 40')!;
  await userEvent.wheel(box, { delta: { y: 400 }, times: 10 });
  await until('the last row is inside the sheet', () => inside(last, box));
});

// owner 10-07「手机端创建新 agent……那些设置经常超出竖直长度,又没有滚动条」。实测(14b6012e3e):12 个项目在 360×640 上
// 被压成两行半的小窗,在下面的设置行上划不动;360×400 时项目列表压成 0 行。
for (const [w, h] of [[360, 640], [360, 400]] as const) {
  it(`create options, 12 projects at ${w}×${h}: the project list keeps its rows, the settings rows scroll the sheet to the last setting, the head stays on top`, async () => {
    await page.viewport(w, h);
    const projects = Array.from({ length: 12 }, (_, i) => ({ id: `p${i + 1}`, name: `project-${i + 1}`, path: `/Users/owner/Codebase/project-${i + 1}` }));
    const options = {
      projects,
      harnesses: [{ id: 'codex', name: 'Codex', status: 'available', sessionViews: ['general', 'code'], permissionModes: ['plan', 'read-only', 'edit', 'full-access'], watchable: true }],
      lastUsed: null,
    } as unknown as Parameters<typeof CreateOptionsPill>[0]['options'];
    const models = {
      harness: 'codex', transport: 'acp', selected: null, selectedEffort: null, harnessState: 'ready', harnessReason: null, guguReason: null,
      models: [{ id: 'm1', name: 'Model 1', source: 'harness' }],
      efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
    } as unknown as Parameters<typeof CreateOptionsPill>[0]['models'];
    const selection = { projectId: 'p1', harness: 'codex', model: null, sessionView: null, permissionMode: null, effort: null };
    mount(<CreateOptionsPill options={options} selection={selection} onChange={() => {}} busy={false} models={models} modelsState="ready" />);
    await userEvent.click(page.getByTestId('agent-watch-create-options-open'));
    await until('12 projects in the sheet', () => document.querySelectorAll('[data-testid="agent-watch-create-options"] [data-dimension="project"] [role="radio"]').length === 12);
    const box = sheet('agent-watch-create-options')!;
    const group = box.querySelector<HTMLElement>('.gg-aw-choice-group[data-dimension="project"]')!;
    const rows = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    const rowsHeight = rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
    expect.soft(group.getBoundingClientRect().height, 'the project list is not squashed into a small window').toBeGreaterThanOrEqual(rowsHeight - 1);
    const summary = box.querySelector<HTMLElement>('.gg-aw-summary-group')!;
    const lastSetting = [...summary.querySelectorAll('[data-testid="agent-watch-create-options-drill"]')].at(-1)!;
    expect(lastSetting.getAttribute('data-dimension'), 'the last setting is the reasoning effort').toBe('effort');
    // 手指落在设置行上滑:原来那一块不是滚动区,划不动。
    await userEvent.wheel(summary, { delta: { y: 400 }, times: 10 });
    await until('the last setting is inside the sheet', () => inside(lastSetting, box));
    const head = box.querySelector<HTMLElement>('.gg-aw-sheet-head')!;
    expect.soft(Math.abs(head.getBoundingClientRect().top - box.getBoundingClientRect().top), 'the head stays at the top of the sheet').toBeLessThanOrEqual(1);
    const nav = page.getByTestId('agent-watch-create-options-nav').element() as HTMLElement;
    const navBox = nav.getBoundingClientRect();
    expect.soft(nav.contains(document.elementFromPoint(navBox.left + navBox.width / 2, navBox.top + navBox.height / 2)), 'the close button is on top, not covered by scrolled rows').toBe(true);
    // 往回滚,最后一个项目也够得着:落点打得中它(❌ 被吸顶的头盖住)。
    const lastProject = rows.at(-1)!;
    const hit = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return inside(el, box) && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    };
    for (let step = 0; step < 40 && !hit(lastProject); step += 1) {
      await userEvent.wheel(box, { delta: { y: lastProject.getBoundingClientRect().top < box.getBoundingClientRect().top + head.offsetHeight ? -40 : 40 } });
    }
    expect(hit(lastProject), 'the last project is reachable').toBe(true);
  });
}

it('member profile: with a 995-character bio the owner still reaches the role select and remove', async () => {
  const bio = Array.from({ length: 15 }, (_, i) => `${i + 1}. 你好，我是做独立游戏的程序员，平时写引擎和工具链，也喜欢拍照、骑车和做饭。最近在研究实时战略游戏里的寻路和编队，欢迎一起聊。`).join(' ');
  const member = { id: 'member-b', guguNumber: 110356, displayName: 'B', avatar: null, bio, email: null, type: 'human', role: 'member', profileScope: 'group' } as MemberProfileCardModel;
  mount(<MemberProfilePopover profile={{ member, anchor: document.body }} onClose={() => {}} editControls={{ canChangeRole: true, onChangeRole: () => {}, canRemove: true, onRemove: () => {} }} />);
  await until('the card is in the sheet', () => sheet('group-member-profile-menu')?.querySelector('[data-profile-member-id] button') != null);
  const box = sheet('group-member-profile-menu')!;
  const card = box.querySelector<HTMLElement>('[data-profile-member-id]')!;
  const last = [...card.querySelectorAll('button')].at(-1)!;
  await userEvent.wheel(card, { delta: { y: 400 }, times: 10 });
  await until('the last manage control is inside the sheet', () => inside(last, box));
});

it('request detail: a 60-line note keeps who sent it and the footer in the sheet, the note scrolls', async () => {
  const note = Array.from({ length: 60 }, (_, i) => String(i + 1)).join('\n');
  const peer = { id: 'peer-c', display_name: 'Sender C', avatar: null, gugu_number: 110357, type: 'human' as const };
  mount(<RequestDetailSheet peer={peer} context="wants to add you" message={note} footer={<><button type="button">Ignore</button><button type="button">Accept</button></>} onClose={() => {}} />);
  await until('the note is in the sheet', () => sheet('request-detail')?.querySelector('p') != null);
  const box = sheet('request-detail')!;
  const name = [...box.querySelectorAll('div')].find((el) => el.textContent === 'Sender C')!;
  expect.soft(inside(name, box), 'who sent it is inside the sheet').toBe(true);
  expect.soft(inside([...box.querySelectorAll('button')].find((el) => el.textContent === 'Accept')!, box), 'the footer is inside the sheet').toBe(true);
  const text = box.querySelector('p')!;
  const end = document.createRange();
  end.setStart(text.firstChild!, note.length - 2);
  end.setEnd(text.firstChild!, note.length);
  await userEvent.wheel(text, { delta: { y: 400 }, times: 10 });
  await until('the last line of the note is visible', () => end.getBoundingClientRect().bottom <= Math.min(text.getBoundingClientRect().bottom, box.getBoundingClientRect().bottom) + 1);
});

it('share intake: 30 shared files leave the chat list on screen', async () => {
  const files = Array.from({ length: 30 }, (_, i) => new File(['x'], `weekly-${String(i + 1).padStart(2, '0')}.txt`, { type: 'text/plain' }));
  mount(<Sheet open onClose={() => {}} fullScreenMobile testId="share-intake-sheet"><ShareIntakeContent share={{ text: null, files, failures: [] }} onDone={() => {}} /></Sheet>);
  await until('the chat row is rendered', () => sheet('share-intake-sheet')?.querySelector('[data-share-target]') != null);
  const box = sheet('share-intake-sheet')!;
  await until('the first chat to send to is on screen', () => inside(box.querySelector('[data-share-target]')!, box));
});

// L11 复核:预览封顶以后它是 flex 列,放不下时先压里面最小高度为 0 的滚动容器(三行文字、横滑的缩略图) —— 同摘要组被压 53 px 那一条。
it('share intake, mixed: text + 3 images + 25 files keep the text and the thumbnails whole, the chat list stays on screen', async () => {
  const text = '周末出游的路线和预算，大家看一下有没有问题。'.repeat(8);
  const images = Array.from({ length: 3 }, (_, i) => new File(['x'], `photo-${i + 1}.png`, { type: 'image/png' }));
  const files = Array.from({ length: 25 }, (_, i) => new File(['x'], `weekly-${String(i + 1).padStart(2, '0')}.txt`, { type: 'text/plain' }));
  mount(<Sheet open onClose={() => {}} fullScreenMobile testId="share-intake-sheet"><ShareIntakeContent share={{ text, files: [...images, ...files], failures: [] }} onDone={() => {}} /></Sheet>);
  await until('the chat row is rendered', () => sheet('share-intake-sheet')?.querySelector('[data-share-target]') != null);
  const box = sheet('share-intake-sheet')!;
  const textBox = box.querySelector<HTMLElement>('.gg-si-text')!;
  const thumbs = box.querySelector<HTMLElement>('.gg-si-thumbs')!;
  expect.soft(textBox.getBoundingClientRect().height, 'the text keeps its three lines').toBeGreaterThanOrEqual(3 * parseFloat(getComputedStyle(textBox).fontSize));
  expect.soft(thumbs.getBoundingClientRect().height, 'the thumbnails keep their 56 px').toBeGreaterThanOrEqual(56);
  await until('the first chat to send to is on screen', () => inside(box.querySelector('[data-share-target]')!, box));
});

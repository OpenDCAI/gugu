import { describe, expect, it } from 'vitest';
import { MAX_SCREEN_BLOCKS, ScreenLayoutStore } from './screen-layout';

const s = (sessionId: string) => ({ projectId: 'p', sessionId });
const sessionsOn = (screen: ScreenLayoutStore) => screen.sessions.map((entry) => entry.sessionId);
const focusedSession = (screen: ScreenLayoutStore) => screen.focusedSession?.sessionId;

describe('一屏几块(spec session-page,#7052)', () => {
  it('第一次看一条会话:屏上一块,就是它', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    expect(sessionsOn(screen)).toEqual(['a']);
    expect(focusedSession(screen)).toBe('a');
  });

  it('点左边一行(#7097):组外的一条 → 它单独一屏、那组原样收着;组里的一条 → 整组回来,正看着它那块', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    screen.showBeside(s('b'));
    expect(sessionsOn(screen)).toEqual(['a', 'b']);
    expect(focusedSession(screen)).toBe('b');

    // ❌ 只换掉正看着的那一块(owner 10-10:「另一个被拼的会话还留在那里」)
    screen.show(s('c'));
    expect(sessionsOn(screen)).toEqual(['c']);
    expect(screen.sessionGroups).toEqual([{ anchor: 'a', sessionIds: ['a', 'b'], onScreen: false }]);

    screen.show(s('a'));
    expect(sessionsOn(screen)).toEqual(['a', 'b']);
    expect(focusedSession(screen)).toBe('a');
    expect(screen.sessionGroups).toEqual([{ anchor: 'a', sessionIds: ['a', 'b'], onScreen: true }]);

    // 再去组外,再点回组里另一条:整组回来,正看着点的那条
    screen.show(s('c'));
    screen.show(s('b'));
    expect(sessionsOn(screen)).toEqual(['a', 'b']);
    expect(focusedSession(screen)).toBe('b');
    // 单独看过的 c 不是组,不记着
    expect(screen.parked).toHaveLength(0);
  });

  it('⌘ 点一条在别的组里的:从那组挪过来,那组只剩一块就散了(一条只在一组里)', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    screen.showBeside(s('b'));
    screen.show(s('c'));
    screen.showBeside(s('d'));
    expect(screen.sessionGroups.map((group) => group.sessionIds)).toEqual([['c', 'd'], ['a', 'b']]);

    screen.showBeside(s('b'));
    expect(sessionsOn(screen)).toEqual(['c', 'd', 'b']);
    expect(screen.sessionGroups).toEqual([{ anchor: 'c', sessionIds: ['c', 'd', 'b'], onScreen: true }]);
    expect(screen.parked).toHaveLength(0);
    // a 不在任何组了:点它就是它单独一屏
    screen.show(s('a'));
    expect(sessionsOn(screen)).toEqual(['a']);
  });

  it('框摆在拼之前正看着的那条;它被拿出来 → 摆在剩下的第一条;拿到只剩一块 = 这组散了', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('b'));
    screen.placeAt({ kind: 'session', ...s('a') }, screen.blockOfSession('b')!, 'left');
    screen.showBeside(s('c'));
    expect(sessionsOn(screen)).toEqual(['a', 'c', 'b']);
    expect(screen.sessionGroups[0].anchor).toBe('b');

    // 挪动组里的块不换框的位置
    screen.placeAt({ kind: 'session', ...s('b') }, screen.blockOfSession('a')!, 'left');
    expect(sessionsOn(screen)).toEqual(['b', 'a', 'c']);
    expect(screen.sessionGroups[0].anchor).toBe('b');

    screen.close(screen.blockOfSession('b')!);
    expect(screen.sessionGroups[0]).toMatchObject({ anchor: 'a', sessionIds: ['a', 'c'] });
    screen.close(screen.blockOfSession('c')!);
    expect(screen.sessionGroups).toEqual([]);
    expect(screen.anchorSessionId).toBeNull();
  });

  it('拆开这一组:在屏上 = 只留正看着那块;收着的 = 不再记着', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    screen.showBeside(s('b'));
    screen.showBeside(s('c'));
    screen.focus(screen.blockOfSession('b')!);
    screen.dissolve('a');
    expect(sessionsOn(screen)).toEqual(['b']);
    expect(screen.sessionGroups).toEqual([]);

    screen.showBeside(s('d'));
    screen.show(s('e'));
    expect(screen.parked).toHaveLength(1);
    screen.dissolve('d');
    expect(screen.parked).toHaveLength(0);
    expect(sessionsOn(screen)).toEqual(['e']);
  });

  it('收着的组里的会话没了 / 开成窗:从那组拿走,不到两块就散了', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    screen.showBeside(s('b'));
    screen.showBeside(s('c'));
    screen.show(s('x'));
    screen.forgetSession('b');
    expect(screen.sessionGroups).toEqual([{ anchor: 'a', sessionIds: ['a', 'c'], onScreen: false }]);
    screen.release({ kind: 'session', ...s('a') });
    expect(screen.parked).toHaveLength(0);
    expect(sessionsOn(screen)).toEqual(['x']);
  });

  it('⌘ 点并排放在正看着那块右边;四块满了不接', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    for (const id of ['b', 'c', 'd']) expect(screen.showBeside(s(id))).toBe(true);
    expect(screen.order).toHaveLength(MAX_SCREEN_BLOCKS);
    expect(screen.showBeside(s('e'))).toBe(false);
    expect(sessionsOn(screen)).not.toContain('e');
  });

  it('拖到一块的边上 = 那边分出一块;它本来在屏上 = 那块挪过去(不多出一块);它自己那块的边上不接', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    const a = screen.blockOfSession('a')!;
    expect(screen.placeAt({ kind: 'session', ...s('b') }, a, 'bottom')).toBe(true);
    expect(screen.layout).toMatchObject({ type: 'split', orientation: 'vertical' });
    expect(sessionsOn(screen)).toEqual(['a', 'b']);

    const b = screen.blockOfSession('b')!;
    expect(screen.canPlaceAt({ kind: 'session', ...s('b') }, b)).toBe(false);
    expect(screen.placeAt({ kind: 'session', ...s('a') }, b, 'right')).toBe(true);
    expect(screen.order).toHaveLength(2);
    expect(sessionsOn(screen)).toEqual(['b', 'a']);
    expect(screen.layout).toMatchObject({ type: 'split', orientation: 'horizontal' });
  });

  it('满了:屏外的东西拖到边上不接;屏上那几块之间照样能挪', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    for (const id of ['b', 'c', 'd']) screen.showBeside(s(id));
    const a = screen.blockOfSession('a')!;
    expect(screen.canPlaceAt({ kind: 'session', ...s('e') }, a)).toBe(false);
    expect(screen.canPlaceAt({ kind: 'session', ...s('d') }, a)).toBe(true);
  });

  it('关掉一块:它从屏上拿走,正看着的跟到旁边那块;只剩一块时不关', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    screen.showBeside(s('b'));
    const b = screen.blockOfSession('b')!;
    expect(screen.close(b)).toBe(true);
    expect(sessionsOn(screen)).toEqual(['a']);
    expect(focusedSession(screen)).toBe('a');
    expect(screen.close(screen.blockOfSession('a')!)).toBe(false);
  });

  it('App 单独一块也是这组的一块:去看组外的会话,App 跟着这组收起来;回到这组它也回来', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    const a = screen.blockOfSession('a')!;
    screen.placeAt({ kind: 'app', tabKind: 'x.clock' }, a, 'right');
    expect(screen.blockOfApp('x.clock')).toBeDefined();
    expect(screen.focusedSession).toBeUndefined();
    // 只有一条会话的组不画框(左边列表里没有 App)
    expect(screen.sessionGroups).toEqual([]);

    screen.show(s('b'));
    expect(sessionsOn(screen)).toEqual(['b']);
    expect(screen.blockOfApp('x.clock')).toBeUndefined();
    expect(screen.parkedSessionOfApp('x.clock')?.sessionId).toBe('a');

    screen.show(s('a'));
    expect(screen.blockOfApp('x.clock')).toBeDefined();
    expect(focusedSession(screen)).toBe('a');
  });

  it('只有 App 没有会话的一屏不收起来(点不回来);一条会话拼一个 App 不算左边的框', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    const a = screen.blockOfSession('a')!;
    screen.placeAt({ kind: 'app', tabKind: 'x.clock' }, a, 'right');
    expect(screen.isGrouped('a')).toBe(false);
    screen.placeAt({ kind: 'app', tabKind: 'x.notes' }, screen.blockOfApp('x.clock')!, 'right');
    screen.close(screen.blockOfSession('a')!);
    expect(screen.order).toHaveLength(2);
    screen.show(s('b'));
    expect(sessionsOn(screen)).toEqual(['b']);
    expect(screen.parked).toHaveLength(0);
    screen.showBeside(s('c'));
    expect(screen.isGrouped('b')).toBe(true);
  });

  it('屏上只剩 App 块时看一条会话:它单独一屏(一块不是组,不记着)', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    screen.placeAt({ kind: 'app', tabKind: 'x.clock' }, screen.blockOfSession('a')!, 'right');
    screen.close(screen.blockOfSession('a')!);
    expect(sessionsOn(screen)).toEqual([]);
    screen.show(s('b'));
    expect(screen.order.map((id) => screen.blocks.get(id)?.kind)).toEqual(['session']);
    expect(screen.parked).toHaveLength(0);
  });

  it('会话没了(归档、删除):它那块收掉;它是唯一一块就清空整屏', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    screen.showBeside(s('b'));
    screen.forgetSession('b');
    expect(sessionsOn(screen)).toEqual(['a']);
    screen.forgetSession('a');
    expect(screen.layout).toBeNull();
    screen.show(s('c'));
    expect(sessionsOn(screen)).toEqual(['c']);
  });

  it('角:左上那块让开展开侧栏的钮,右上那块让开窗口控制', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    const a = screen.blockOfSession('a')!;
    screen.placeAt({ kind: 'session', ...s('b') }, a, 'right');
    screen.placeAt({ kind: 'session', ...s('c') }, screen.blockOfSession('b')!, 'bottom');
    expect(screen.corners(a)).toEqual({ topLeft: true, topRight: false });
    expect(screen.corners(screen.blockOfSession('b')!)).toEqual({ topLeft: false, topRight: true });
    expect(screen.corners(screen.blockOfSession('c')!)).toEqual({ topLeft: false, topRight: false });
  });

  it('对半放不下(调用方量过):这一排一起均分', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    screen.showBeside(s('b'));
    screen.placeAt({ kind: 'session', ...s('c') }, screen.blockOfSession('a')!, 'right', { even: true });
    expect(screen.layout).toMatchObject({ type: 'split', sizes: [34, 33, 33] });
  });

  it('存下来再读回:形状、每块装什么、正看着哪块都照旧;认不出的块丢掉', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    screen.placeAt({ kind: 'session', ...s('b') }, screen.blockOfSession('a')!, 'bottom');
    screen.placeAt({ kind: 'app', tabKind: 'x.clock' }, screen.blockOfSession('b')!, 'right');
    screen.focus(screen.blockOfSession('a')!);
    const saved = JSON.parse(JSON.stringify(screen.snapshot));

    const again = new ScreenLayoutStore();
    again.restore(saved);
    expect(sessionsOn(again)).toEqual(['a', 'b']);
    expect(again.blockOfApp('x.clock')).toBeDefined();
    expect(focusedSession(again)).toBe('a');
    expect(again.layout).toMatchObject({ type: 'split', orientation: 'vertical' });

    // 新分出来的块不和读回来的撞号
    again.showBeside(s('c'));
    expect(new Set(again.order).size).toBe(again.order.length);

    const broken = new ScreenLayoutStore();
    broken.restore({ ...saved, blocks: { ...saved.blocks, 'block-x': { kind: 'nope' } } });
    expect(broken.order).toHaveLength(3);

    // 同一条会话、同一个 App 在记录里出现两次:只留一块
    const doubled = new ScreenLayoutStore();
    doubled.restore({
      ...saved,
      blocks: { ...saved.blocks, 'block-y': { kind: 'session', ...s('a') }, 'block-z': { kind: 'app', tabKind: 'x.clock' } },
    });
    expect(sessionsOn(doubled)).toEqual(['a', 'b']);
    expect(doubled.order).toHaveLength(3);

    // 形状那半坏了:当没存过,这屏一点不动 —— ❌ 块记着、形状没有
    const mangled = new ScreenLayoutStore();
    mangled.restore({ ...saved, layout: { split: 'vertical' } as never });
    expect(mangled.blocks.size).toBe(0);
    expect(mangled.blockOfSession('a')).toBeUndefined();
    // 之后点左边那一行:它照常摆出来,❌ 当成「已经摆着」去找一块画不出来的块
    mangled.show(s('a'));
    expect(sessionsOn(mangled)).toEqual(['a']);
    expect(focusedSession(mangled)).toBe('a');
  });

  it('存下来再读回:收着的组也照旧(重启后点组里的一条整组回来);两组里重了的留先读到的,不到两块的不再是组', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    screen.showBeside(s('b'));
    screen.show(s('c'));
    screen.showBeside(s('d'));
    screen.focus(screen.blockOfSession('c')!);
    const saved = JSON.parse(JSON.stringify(screen.snapshot));
    expect(saved.parked).toHaveLength(1);

    const again = new ScreenLayoutStore();
    again.restore(saved);
    expect(sessionsOn(again)).toEqual(['c', 'd']);
    expect(focusedSession(again)).toBe('c');
    expect(again.sessionGroups).toEqual([
      { anchor: 'c', sessionIds: ['c', 'd'], onScreen: true },
      { anchor: 'a', sessionIds: ['a', 'b'], onScreen: false },
    ]);
    again.show(s('b'));
    expect(sessionsOn(again)).toEqual(['a', 'b']);
    expect(focusedSession(again)).toBe('b');
    // 读回来之后新分出来的块不和收着的那组撞号
    again.show(s('e'));
    again.showBeside(s('f'));
    const ids = [...again.order, ...again.parked.flatMap((group) => Object.keys(group.blocks))];
    expect(new Set(ids).size).toBe(ids.length);

    // 收着的那组里有这屏已经有的会话:那块丢掉,剩一块就不再是组
    const doubled = new ScreenLayoutStore();
    doubled.restore({ ...saved, parked: [{ ...saved.parked[0], blocks: { ...saved.parked[0].blocks, [Object.keys(saved.parked[0].blocks)[0]]: { kind: 'session', ...s('c') } } }] });
    expect(doubled.parked).toHaveLength(0);

    // 老记录(没有收着的组)照样读得回
    const legacy = new ScreenLayoutStore();
    legacy.restore({ layout: saved.layout, blocks: saved.blocks, focused: saved.focused });
    expect(sessionsOn(legacy)).toEqual(['c', 'd']);
    expect(legacy.sessionGroups[0].anchor).toBe('c');
  });

  it('最近看过的会话:正看着 App 那块时,是之前看过的那块会话', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    screen.showBeside(s('b'));
    screen.placeAt({ kind: 'app', tabKind: 'x.clock' }, screen.blockOfSession('b')!, 'right');
    screen.focus(screen.blockOfSession('a')!);
    screen.focus(screen.blockOfApp('x.clock')!);
    expect(screen.focusedSession).toBeUndefined();
    expect(screen.recentSession?.sessionId).toBe('a');
  });

  it('拿走之前记下它挨着谁、在哪边(放回来回到原处)', () => {
    const screen = new ScreenLayoutStore();
    screen.show(s('a'));
    screen.showBeside(s('b'));
    screen.placeAt({ kind: 'session', ...s('c') }, screen.blockOfSession('b')!, 'bottom');
    expect(screen.originOf(screen.blockOfSession('b')!)).toEqual({ neighborId: screen.blockOfSession('c'), edge: 'top' });
    expect(screen.originOf(screen.blockOfSession('c')!)).toEqual({ neighborId: screen.blockOfSession('b'), edge: 'bottom' });
    expect(screen.originOf(screen.blockOfSession('a')!)).toEqual({ neighborId: screen.blockOfSession('b'), edge: 'left' });
  });
});

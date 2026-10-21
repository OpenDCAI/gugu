import { createContext, useContext } from 'react';

/**
 * 一个会话页此刻摆在这屏的哪一块(spec session-page「一屏几块」)。会话页里要知道的只有这些:
 * 它是不是正看着的那块(document 级快捷键只给它)、在不在左上 / 右上角(让开展开侧栏的钮 / 窗口控制)、
 * 屏上是不是不止一块(页签条右端那枚「关闭这一块」)。
 */
export type ScreenBlockPlace = {
  /** 不在任何一块里(没摆在屏上,或这个会话页不在主屏上)= null。 */
  blockId: string | null;
  focused: boolean;
  topLeft: boolean;
  topRight: boolean;
  multi: boolean;
  /** 在单独的窗里:那扇窗的 id(页签条就是标题栏,右端是「放回咕咕」)。 */
  windowId?: string;
};

/** mac 上单独成窗时,页签条左端让开原生红绿灯的宽度(灯在 x=5 起,三颗约 52px,再留一点呼吸)。 */
export const AUX_WINDOW_TRAFFIC_LIGHTS_PX = 72;

/** 默认 = 一屏只有它一块:左上、右上都是它,它就是正看着的。 */
export const ScreenBlockContext = createContext<ScreenBlockPlace>({
  blockId: null,
  focused: true,
  topLeft: true,
  topRight: true,
  multi: false,
});

export const useScreenBlock = (): ScreenBlockPlace => useContext(ScreenBlockContext);

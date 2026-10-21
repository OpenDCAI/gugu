import { createContext, useContext, useEffect, useRef } from "react";
import { useAuiEvent, useThreadViewport } from "@assistant-ui/react";

/**
 * @@@toggle-pauses-follow - 人在视口里点开或收起一行，等于暂停跟随底部，和往上滑一样;人回到底部，再恢复跟随
 * (owner 10-18)。不然停在底部点开中间一行时，下一条新输出一到，跟随底部就把这次点开长出来的高度当成新内容，
 * 一起滚上去，被点的那一行被顶走。
 *
 * 滚动仍只有视口一处负责：暂停 = `ThreadPrimitive.Viewport` 的 `autoScroll` 关掉;恢复 = 打开它，
 * 再经视口自己的 `scrollToBottom` 重新挂上跟随(人在暂停期间往上滑过的话，视口内部的跟随标记已经清掉了)。
 */
const PauseFollowContext = createContext<() => void>(() => {});

/** 点开 / 收起时调它。线程视口之外没有跟随可暂停，所以缺省什么都不做。 */
export const usePauseFollow = () => useContext(PauseFollowContext);

export const PauseFollowProvider = PauseFollowContext.Provider;

/**
 * 放在 Viewport 里面(视口的 store 在那里才有)。暂停以后，人离开过底部、又回到底部，就恢复跟随。
 * 「离开过」要先发生：点开那一刻人还在底部，那不是「回来了」。
 * 人在这台手机上发一句话也恢复：发消息就是要看回复(收起时人没离开过底部，不这样就永远等不到「回来」)。
 * 视口自己在 runStart 时滚到底，这里只把 `autoScroll` 打开。
 */
export function ResumeFollowAtBottom({ paused, onResume }: { paused: boolean; onResume: () => void }) {
  const isAtBottom = useThreadViewport((s) => s.isAtBottom);
  const scrollToBottom = useThreadViewport((s) => s.scrollToBottom);
  const leftBottom = useRef(false);
  useAuiEvent("thread.runStart", onResume);
  useEffect(() => {
    if (!paused) {
      leftBottom.current = false;
      return;
    }
    if (!isAtBottom) {
      leftBottom.current = true;
      return;
    }
    if (!leftBottom.current) return;
    onResume();
    scrollToBottom({ behavior: "instant" });
  }, [paused, isAtBottom, onResume, scrollToBottom]);
  return null;
}

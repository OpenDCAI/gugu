// 说明文字里的一个动作:句子里的一段强调色(链接蓝)文字,❌ 底下另摆一颗按钮
// (与 device-scope-picker 的「再试一次」同一个写法;链接蓝是 ui-visual-spec ③-a 的有界例外)。
import type { ReactNode } from 'react';

export function InlineAccentAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="cursor-pointer text-foreground-info underline-offset-2 hover:underline" onClick={onClick}>
      {children}
    </button>
  );
}

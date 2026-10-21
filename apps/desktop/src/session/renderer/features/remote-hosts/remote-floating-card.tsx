import type { ReactNode } from 'react';
import { cn } from '@renderer/utils/utils';

/**
 * #6264 浮在远端终端 / 远端浏览器上的一张卡片(ssh 在问 / 指纹变了),居中在面板顶部 ——
 * 照 Zed 连接提问与 VS Code quick input 的位置:顶部居中,不挡住下面正在发生的事。
 * 终端与浏览器共用这一份,❌ 各抄一遍(design.md:A second implementation of something the kit already ships)。
 * 浮在内容上 = 浮层,与命令面板 / 对话框同一条公式(docs/ui-visual-spec.md §6.3):
 * bg-background-quaternary + --radius-xl + 唯一那档 lift;无 ring、无 border、无第二档投影。
 * 「哪台机器、在连什么」写在卡片里面的第一行(SshPromptFrame 的 context),
 * ❌ 卡片外面再挂一颗说明胶囊 —— 两个浮起来的东西叠在一起,读起来就是拼上去的。
 * `offsetClassName` 只管离顶多远:浏览器要让开自己的地址栏。
 */
export function RemoteFloatingCard({
  children,
  testId,
  offsetClassName = 'top-3',
}: {
  children: ReactNode;
  testId: string;
  offsetClassName?: string;
}) {
  return (
    <div className={cn('pointer-events-none absolute inset-x-0 z-10 flex justify-center px-4', offsetClassName)} data-testid={testId}>
      <div className="pointer-events-auto w-full max-w-[440px] overflow-hidden rounded-[var(--radius-xl)] bg-background-quaternary text-foreground shadow-lift">
        {children}
      </div>
    </div>
  );
}

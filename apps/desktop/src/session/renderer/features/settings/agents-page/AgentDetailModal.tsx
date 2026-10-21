import { observer } from 'mobx-react-lite';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { useManagementAgent } from '@renderer/lib/stores/use-agents';
import { Dialog, DialogContent, DialogContentArea, DialogHeader } from '@renderer/lib/ui/dialog';
import { ModalLayout } from '@renderer/lib/ui/modal-layout';
import { cn } from '@renderer/utils/utils';
import { AgentAccountSection } from './AgentAccountSection';
import { AgentModalHeaderSection } from './AgentModalHeaderSection';
import { InstallSection } from './InstallSection';

interface AgentDetailModalProps {
  agentId: string | null;
  onClose: () => void;
}

/**
 * @@@6088 内容区的高度上限 —— 这一条是**几何必需**,不是保险。
 *
 * 面板内容是可变高的(未装 / 已装 / 装到一半带进度条 / 手动指定输入框展开),而 `ModalLayout`
 * 里的 `AnimatedHeight` 会把**量到的内容高**当成一个显式 `height` 写回去。不给内容区封顶,
 * 那个数就无界:弹窗自己 `overflow-hidden`,超出的部分被**裁掉且没有滚动条**,够不到 ——
 * 那正是右侧抽屉改成居中模态框时唯一会退步的一格(抽屉是满屏高,长内容天然放得下)。
 * 封顶之后量到的高有界,溢出的部分由内容区自己那条 `overflow-y-auto` 滚。
 *
 * 8rem 是「弹窗自己的 2rem 视口余量 + 标题行」再留一点:算出来的内容上限必须小于
 * `DialogContent` 的 `max-h`,否则封顶就不起作用。
 */
const CONTENT_MAX_HEIGHT = 'max-h-[calc(100dvh-8rem)]';

const AgentDetailModalContent = observer(function AgentDetailModalContent({
  agentId,
}: {
  agentId: string;
  onClose: () => void;
}) {
  const { data: agentPayload } = useManagementAgent(agentId);
  /**
   * 资源库看的是一台离线的机器(#6264):照旧画它上次的样子,但一个动作都做不了 —— 那台机器此刻收不到。
   * 用一个 disabled 的 fieldset 把整块面板里的按钮、输入框一次关掉,❌ 每个控件各判一遍(总会漏一个)。
   */
  const host = useLibraryHost();
  const readOnly = host.remote ? !host.remote.online : false;

  /**
   * 卡头就是这一家的 App 图标 + 名字(`AgentModalHeaderSection`)。
   *
   * ❌ 从前卡头上方还有一行小字标题,按「装没装」在「智能体设置 / 安装智能体」之间翻
   * (#6101 定过判据)。现在装没装由状态那一行说,标题只有名字 —— 同一件事不说两遍。
   */
  const dimmed = agentPayload ? agentPayload.reading === 'not-detected' : false;

  return (
    <ModalLayout
      header={
        <DialogHeader>
          {agentPayload && <AgentModalHeaderSection agent={agentPayload} dimmed={dimmed} />}
        </DialogHeader>
      }
      footer={null}
    >
      <DialogContentArea className={cn('gap-0', CONTENT_MAX_HEIGHT)}>
        {agentPayload && (
          /* 顺序 = 用户要回答的问题的顺序:装没装(状态 + 三个按钮)→ 登没登(账号)→ 高级。
             段与段之间一条细线,❌ 不再给每段套一个框(从前是框里套框,安装那个框下半截还是空的)。 */
          <fieldset disabled={readOnly} className="contents" data-read-only={readOnly || undefined}>
            <InstallSection
              agentId={agentId}
              agentPayload={agentPayload}
              installOptions={agentPayload.installOptions}
              installDocs={agentPayload.installDocs}
              accountSlot={<AgentAccountSection agent={agentPayload} />}
            />
          </fieldset>
        )}
      </DialogContentArea>
    </ModalLayout>
  );
});

/**
 * 「智能体设置」= 居中模态框(#6088)。
 *
 * 它干的是「读一份配置、改完就关」,不是「在主内容旁边开条侧栏对照着看」—— 从前是
 * `Sheet side="right"`,形态上是抽屉、行为上却已经是模态的(遮罩、点外面关、下面不能操作),
 * 而同一页的 `AgentSignInModal` 早就是居中模态框。❌ 别改回 Sheet。
 *
 * `sheet.tsx` 里那条 `SHEET_SAFE_INSET_RIGHT`(#6034,让开自绘窗口按钮那条车道)对居中模态框
 * 不再适用:它是「贴着窗口右上角」才有的问题,而这个弹窗离右缘还有半个屏。**但 Sheet 还有别的
 * 消费者**(automations、IntegrationsCard)⇒ ❌ 别顺手把它从 `sheet.tsx` 里删掉。
 */
export function AgentDetailModal({ agentId, onClose }: AgentDetailModalProps) {
  return (
    <Dialog open={agentId !== null} onOpenChange={(open) => !open && onClose()}>
      {/* 宽度沿用抽屉那版的 36rem(`data-[side=right]:sm:max-w-xl`):安装命令行与环境变量两列
          是按这个宽度排的,收窄会多出一轮换行。 */}
      <DialogContent className="sm:max-w-xl">
        {agentId && <AgentDetailModalContent agentId={agentId} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

import { useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { TemplateRoleMarker } from '../../components/TemplateRoleMarker'
import { Button } from '../../components/ui/Button'
import { Chip } from '../../components/ui/Chip'
import { getPresetTeamBanner } from '../../lib/presetTeamGallery'
import type { PresetTeam } from '../../lib/presetTeams'

/**
 * 工作台的预设团队卡。
 *
 * 版式基于 owner 指定的 ProjectCard 参考稿（shadcn 语汇：group-hover 图片缩放、整卡上浮、
 * 箭头 CTA），按咕咕的实际情况做了四处落地改动：
 *
 *  1. 颜色走 shadcn 语义色（bg-card / text-card-foreground / text-muted-foreground / text-primary）。
 *     这些 utility 在改之前是**哑的** —— tokens.css 的 @theme 只桥了 7 个 key，card 系列不在其中，
 *     Tailwind v4 会静默丢掉整条 utility。桥已在 tokens.css 补全，见那里的说明。
 *  2. 图标用 @/lib/icons（Solar 对 lucide-react 的 drop-in，API 一致），不直接 import lucide。
 *     参考稿的 ArrowRight 不在 Solar 集里，且生成脚本 gen-icons-module.js 已不在仓库中
 *     （icons.tsx 标着「勿手改」），所以换成集里现成的 ChevronRight——同样是「向前」语义。
 *  3. 圆角用 rounded-xl(12px) 而不是参考稿的 rounded-2xl(16px)：16 不在 tokens 的 4/6/8/12 刻度上。
 *  4. 参考稿的 CTA 是「跳外链」，这里是「组建团队」这个动作 —— 用 <button> 而不是 <a>，
 *     否则读屏会把一个会创建东西的控件念成链接。箭头位移的观感保留。
 *
 * hover 反馈**不取参考稿的整卡上浮**（owner 授权按美感定夺）。理由按重要性排：
 *   ① 这张卡本身不可点 —— 只有下面那个「组建」按钮有 onClick，根节点既无 onClick 也无
 *      cursor-pointer。参考稿的上浮是与「整卡是个链接」绑定的（它根节点写了 cursor-pointer，
 *      还特意 stopPropagation 防自身 onClick）。在不可点的容器上做上浮 = 承诺一个不存在的
 *      可点性：鼠标划过卡片它抬起来，点下去却什么都不发生。要么让整卡可点、要么别抬，
 *      而「组建」是创建团队这种重动作，不该被误点触发。
 *   ② 一排三张卡顶边齐平；悬停时单独抬起一张会打破这条水平线，密网格里读起来是抖动。
 *      实测 -translate-y-1 = 4px（Tailwind 一单位 4px，参考稿的 -2 是 8px）。
 *   ③ 阴影本来就是「浮起来」的表达，不必再叠位移。
 *
 * @@@3079-calm-hover 悬停反馈改为**只动颜色与背景**（calm-ui：hover 不得动 opacity / transform /
 * scale / shadow）。原来是 shadow-lg + 图片 scale-105，那版自己的注释就记录了它的毛病：
 * 「亮色 shadow 清晰可见；暗色黑阴影落在近黑表面上基本不可见，由 border 接管」——
 * 即两套主题各靠一个不同的信号，暗色下等于只剩边框。
 *
 * 现在两套主题共用同一套机制：边框提亮 + 表面叠一层 --hover。它在明暗下都成立，
 * 不再需要「哪个信号在哪个主题生效」这种分支解释，也不会在网格里制造浮起/缩放的噪声。
 * 卡片占位始终不变。减少动效由 tokens.css 的全局开关兜底，这里不必重复声明。
 */
export function PresetTeamCard({
  team,
  onAction,
  priority,
  className,
  style,
}: {
  team: PresetTeam
  onAction: () => void
  priority: boolean
  className?: string
  style?: CSSProperties
}) {
  const { t } = useTranslation('discover')
  const banner = getPresetTeamBanner(team.id)
  const [bannerFailed, setBannerFailed] = useState(false)

  return (
    <article
      data-team-id={team.id}
      style={style}
      className={cn(
        // 圆角走 --r-lg（12px，「大卡」档），不吃 Tailwind rounded-xl 自己的默认值——
        // 那个默认值恰好也是 12 纯属巧合，没有钉在 token 上。
        'gg-team group relative flex flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-card text-card-foreground',
        'transition-[background-color,border-color] duration-[var(--dur-med)] ease-out',
        'hover:border-foreground/25 hover:bg-accent focus-within:border-foreground/25 focus-within:bg-accent',
        className,
      )}
    >
      <div className="aspect-video overflow-hidden border-b border-border bg-muted">
        {(bannerFailed || !banner)
          ? (
              <div
                role="alert"
                data-testid={`preset-team-banner-error-${team.id}`}
                className="grid h-full w-full place-items-center p-4 text-center text-xs text-muted-foreground"
              >
                {t('team.bannerError')}
              </div>
            )
          : (
              <img
                src={banner.src}
                alt={t(banner.altKey)}
                width={1672}
                height={941}
                loading={priority ? 'eager' : 'lazy'}
                decoding="async"
                onError={() => { setBannerFailed(true) }}
                className="h-full w-full object-cover object-center dark:brightness-[0.78] dark:saturate-[0.88]"
              />
            )}
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <h2 className="min-w-0 break-words text-base font-semibold leading-[1.35] transition-colors duration-[var(--dur-med)] group-hover:text-primary">
            {team.name}
          </h2>
          <span className="shrink-0 text-xs text-muted-foreground">
            {t('team.agentCount', { count: team.roles.length })}
          </span>
        </div>

        {/* 「适用/交付」标签降到 medium/muted——原来 semibold + card-foreground 与团队名同一档粗细,
            读起来两者抢重音;标签只需要标出「这是标签」,不必抢过它标注的内容。 */}
        <div className="mt-3 grid gap-2">
          <p className="break-words text-sm leading-[1.55] text-muted-foreground">
            <span className="mr-2 font-medium text-muted-foreground">{t('team.bestFor')}</span>{team.bestFor}
          </p>
          <p className="break-words text-sm leading-[1.55] text-muted-foreground">
            <span className="mr-2 font-medium text-muted-foreground">{t('team.deliverable')}</span>{team.deliverable}
          </p>
        </div>

        {/* 渐进披露：角色原本在一张卡上出现三遍（计数 + 命名 chip + 头像标记行）。
            标记不能删（@@@2470 方形轮廓 = 「模板角色 ≠ 真人头像」的语义），于是并进 chip。
            走共享 Chip（.gg-chip）而不是自己再拼一套 border/bg/radius/font——小标签这个角色
            全 app 只有一种实现。 */}
        <div className="mb-4 mt-3 flex flex-wrap gap-2" aria-label={t('team.rolesLabel', { team: team.name })}>
          {team.roles.map((role) => (
            <Chip key={role.key}>
              {/* 名字就在右边，标记再报一次自己的 aria-label 是重复噪声 */}
              <span className="gg-role-mark inline-flex shrink-0" aria-hidden="true">
                <TemplateRoleMarker
                  roleKey={role.avatarSeed}
                  templateLabel={t('team.roleTemplate', { title: role.title })}
                  size={16}
                />
              </span>
              {role.title}
            </Chip>
          ))}
        </div>

        {/* 一屏十几张卡上全是「组建」，读屏顺序读下来无从分辨组建的是哪个团队 → aria-label 补出团队名。
            mt-auto 把 CTA 钉在卡底：一行里各卡的正文长短不一（团队描述 2~3 行、角色 chip 1~2 行），
            等高之后若 CTA 各自跟在正文后面，一排「组建」就高低错落。与它的最小间距由角色行的 mb-4 给，
            free space 为 0 时也不会贴到 chip 上。size="sm" 在桌面走 --control-h-sm(28)，<720px 断点
            Button 自己升到触控 44——不必再手写 min-h-11。 */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onAction}
          aria-label={t('team.buildLabel', { team: team.name })}
          className={cn(
            'mt-auto w-fit px-2 text-primary',
            // @@@3079 焦点环由 owner 2026-07-24 全废(tokens.css 全局 outline:none),组件不得自加;
            // hover 只动颜色 —— 下划线already足够,箭头不再位移(calm-ui:hover 不得动 transform)。
            'hover:underline underline-offset-4',
          )}
        >
          {t('team.build')}
          <ChevronRight size={15} />
        </Button>
      </div>
    </article>
  )
}

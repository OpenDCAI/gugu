import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  SessionOptionDimension,
  SessionOptionGroup,
  SessionpageSessionOptions
} from '@gugu/session-core/session-record/contract'
import { Check, ChevronDown, ChevronLeft, ChevronRight, X } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Sheet } from '@/components/ui/Sheet'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/client'
import { localizePermissionModeOptions, selectedPermissionModeId } from '@renderer/features/sessions/acp/permission-mode-options'
import type { SessionpageSessionOptionsWithMenu } from '@main/core/session-timeline/session-model-menu'
import { sessionModelView } from './session-model-menu'
import { ModelMenuFooter } from './ModelMenuFooter'
import { SessionpageRpcError, fetchSessionOptions, reloadSessionModel, setSessionOption } from './sessionpage-rpc'

/**
 * 会话选项 —— 摆在**输入框那一行**，形制与交互逐条照 orca 手机端
 * （`mobile/src/session/MobileNativeChatSessionOptionPickers.tsx` 与同目录的
 * `MobileNativeChatSessionOptionRows.tsx`，2026-09-06 读的 main 分支）：
 *
 *   · 胶囊上只写**值**（模型名 · 其余档位的值），从不写状态词；单行截断、宽度封顶。
 *     ⚠️ 中间版本在会话没在跑时留了个写「没在跑」的禁用胶囊，owner 第一反应是
 *     「这又是个啥东西」—— orca 那边第 48 行是 `if (!model) return null`：
 *     **没得选就整个不画**。一个只写状态、不写自己是什么的控件，比不摆更糟。
 *   · 抽屉是**下钻**，不是把所有档位平铺在一张纸上：
 *       顶层 = 第一档（模型）的选项 + 下面一组「其余档位」摘要行（各带当前值、右侧 ›）
 *       点摘要行 → 换到那一档，左上角从 ✕ 变 ←，标题跟着变
 *     （orca 的 `SessionOptionSummaryRow` + `openDescriptorId` 那套。）
 *   · 选中态是**填满的圆点打勾**，不是行尾挂一个勾（orca `ChoiceRow` 的 radio）。
 *   · 选完**不关**（owner 10-07「调完一个设置后还可以继续调另一个」，新建胶囊同一条）：在下钻页选 → 回顶层，
 *     摘要行上读得到回读的新值，接着点下一档；在顶层选 → 留在顶层、勾移过去。关只靠 ✕ 和点遮罩。
 *   · agent 在跑时全部禁用 —— 跑到一半换模型会和它自己的输出打架。
 *   · 重选当前那一档 = 什么都不做，❌ 不重复下发。
 *
 * 显示的永远是**回读**到的那一份，不是刚点的那个值：provider 可能把这次切换归到另一档上，
 * 也可能压根没接受。显示入参等于报「我发出去了」，而人以为读到的是「它变成了什么」。
 */
function describe(err: unknown): { code: string | null; message: string } {
  if (err instanceof SessionpageRpcError) return { code: err.code, message: err.message }
  return { code: null, message: err instanceof Error ? err.message : String(err) }
}

type Choice = { id: string; name: string; description?: string | null }

/**
 * 一档在抽屉里摆哪几行、选中的是哪一行。
 *
 * 权限档关系到「它能不能不问你就动文件」:照桌面那一份收成咕咕四档(规划 / 只读 / 编辑 / 完全访问),用桌面同一个
 * 函数、同一套文案,档位表是这家自己声明的那张(宿主随选项一起给,`modeMap`)。#6693:这里从前自带一张只认 Claude
 * 五个 id 的表 —— hermes 的 `default` 实为「编辑」(改文件、跑普通命令都不问),却被写成 Claude 的「照常问我」,
 * 正好说反;`yolo`、`auto_edit` 则露原文。宿主没给表(这家没声明)就照它报的名字显示,❌ 猜。
 * 其余维度(模型、思考强度)照报什么显示什么 —— 那些名字本来就是人认得的。
 */
function presentChoices(
  dimension: SessionOptionDimension,
  group: SessionOptionGroup,
  modeMap: ProviderPermissionModeMap | undefined
): { choices: Choice[]; selected: string | null } {
  if (dimension !== 'mode') return { choices: group.available, selected: group.selected ?? null }
  const reported = Object.fromEntries(
    group.available.map((c) => [c.id, { name: c.name, description: c.description ?? undefined }])
  )
  const shown = localizePermissionModeOptions(reported, translateSessionMessage, modeMap) ?? reported
  return {
    choices: Object.entries(shown).map(([id, option]) => ({ id, name: option.name, description: option.description })),
    selected: selectedPermissionModeId(group.selected ?? undefined, reported, modeMap) ?? null,
  }
}

/** 某一档当前选中那个值的名字;取不到就不给 —— ❌ 不编一个。 */
function selectedName(
  dimension: SessionOptionDimension,
  group: SessionOptionGroup,
  modeMap: ProviderPermissionModeMap | undefined
): string | null {
  const { choices, selected } = presentChoices(dimension, group, modeMap)
  return choices.find((c) => c.id === selected)?.name ?? null
}

/** 档位的固定次序:模型在最前(它是抽屉的顶层),其余按这个顺序排在摘要里。 */
const ORDER: SessionOptionDimension[] = ['model', 'mode', 'effort']

function presentGroups(
  options: SessionpageSessionOptions | null
): Array<[SessionOptionDimension, SessionOptionGroup]> {
  if (!options) return []
  const out: Array<[SessionOptionDimension, SessionOptionGroup]> = []
  for (const dimension of ORDER) {
    const group = options[dimension]
    if (group) out.push([dimension, group])
  }
  return out
}

/** 胶囊上写值。一个值都读不到就返回 null —— 那时整个胶囊不画。模型那一格有菜单时写菜单的收起名(「咕咕 X」)。 */
function pillLabel(
  groups: Array<[SessionOptionDimension, SessionOptionGroup]>,
  modeMap: ProviderPermissionModeMap | undefined,
  modelName: string | null
): string | null {
  const parts = groups
    .map(([dimension, group]) => (dimension === 'model' && modelName) || selectedName(dimension, group, modeMap))
    .filter((x): x is string => !!x)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** 一行选项(填满的圆点打勾,orca 同款)。 */
function ChoiceRow({
  dimension,
  id,
  name,
  desc,
  selected,
  disabled,
  onPick
}: {
  dimension: SessionOptionDimension
  id: string
  name: string
  desc: string | null | undefined
  selected: boolean
  disabled: boolean
  onPick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="option"
      className="gg-aw-choice"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      data-testid="agent-watch-option-choice"
      data-dimension={dimension}
      data-option-id={id}
      onClick={onPick}
    >
      <span className="gg-aw-choice-radio" data-on={selected ? 'true' : undefined}>
        {selected ? <Check /> : null}
      </span>
      <span className="gg-aw-choice-body">
        <span className="gg-aw-choice-label">{name}</span>
        {desc ? <span className="gg-aw-choice-desc">{desc}</span> : null}
      </span>
    </Button>
  )
}

export function SessionOptionsPill({
  deviceId,
  sessionId,
  phoneHost = false,
  busy
}: {
  deviceId: string
  sessionId: string
  phoneHost?: boolean
  /** agent 在跑 / 正在发送。跑到一半改选项会与它自己的输出交错,所以锁住。 */
  busy: boolean
}) {
  const { t } = useTranslation('main')
  /** null = 抽屉关着;否则是正看着哪一档。 */
  const [view, setView] = useState<SessionOptionDimension | null>(null)
  const [options, setOptions] = useState<SessionpageSessionOptionsWithMenu | null>(null)
  const [error, setError] = useState<{ code: string | null; message: string } | null>(null)
  const [pending, setPending] = useState<SessionOptionDimension | null>(null)
  /** 等人确认的「换计费路」—— 与桌面会话菜单同一步:先问一句,再让宿主重开。 */
  const [reload, setReload] = useState<{ modelId: string; label: string; source: 'platform' | 'own' } | null>(null)

  // #980 打开会话不叫醒 agent:没在跑的会话宿主只报得出记下的模型,权限档 / 推理档要等它跑起来。它跑完一轮
  // (在跑 → 不在跑)时手里还只有那一份,就再读一次 —— ❌ 等人退出去再进来才看得到。
  const [reread, setReread] = useState(0)
  const wasBusy = useRef(busy)
  const recordOnly = options !== null && !options.mode && !options.effort
  useEffect(() => {
    if (wasBusy.current && !busy && recordOnly) setReread((n) => n + 1)
    wasBusy.current = busy
  }, [busy, recordOnly])

  useEffect(() => {
    let cancelled = false
    fetchSessionOptions(deviceId, sessionId, phoneHost)
      .then((next) => { if (!cancelled) setOptions(next) })
      .catch((err) => { if (!cancelled) setError(describe(err)) })
    return () => { cancelled = true }
  }, [deviceId, sessionId, phoneHost, reread])

  const groups = presentGroups(options)
  const root = groups[0]
  const models = options?.modelMenu && options.model ? sessionModelView(options.modelMenu, options.model) : null
  const modelItem = models?.groups.flatMap((group) => group.items).find((item) => item.id === models.selectedId)
  const modeMap = options?.modeMap
  const label = pillLabel(groups, modeMap, modelItem ? (modelItem.shortName ?? modelItem.name) : null)

  // 没得选就整个不画(orca 同款)。会话没在跑、还没读到、这条会话本来就没有可调档位,
  // 三种情况都落在这里。
  if (!root || !label) return null

  const disabled = busy || pending !== null
  const current = view ? groups.find(([d]) => d === view) : undefined
  const currentChoices = current ? presentChoices(current[0], current[1], modeMap) : null
  const atRoot = current?.[0] === root[0]
  const others = groups.filter(([d]) => d !== root[0])

  const pick = (dimension: SessionOptionDimension, group: SessionOptionGroup, value: string): void => {
    // 重选当前那一档 = 什么都不做(orca 同一条:❌ 不重复下发已经生效的值),只回顶层,像选了别的一样。
    // 「当前那一档」按屏上选中的那一行算(权限档收成四档后,原生 `dontAsk` 显示在「只读」那一行上)。
    if (presentChoices(dimension, group, modeMap).selected === value) {
      setView(root[0])
      return
    }
    setPending(dimension)
    setError(null)
    // 下发失败就停在这一页,错误写在头部下面,可以换一个再点。回来之前人可能已经点 ✕ / 遮罩关了抽屉:
    // 关着就让它关着(`v &&`),❌ 回来时把抽屉重新弹开。
    void setSessionOption(deviceId, { conversationId: sessionId, dimension, value }, phoneHost)
      .then((next) => { setOptions(next); setView((v) => v && root[0]) })
      .catch((err) => setError(describe(err)))
      .finally(() => setPending(null))
  }

  // 桌面会话菜单的 handleModelChange:当场换得成就下发 `wireValue`,要换计费路就先问一句;到不了的行本来就灰着。
  const pickModel = (optionId: string): void => {
    if (!models || !options?.model) return
    const plan = models.plan(optionId)
    if (plan.kind === 'hot') pick('model', options.model, plan.wireValue)
    else if (plan.kind === 'reload') {
      setError(null)
      setReload({ modelId: plan.modelId, label: plan.displayName, source: plan.source === 'platform' ? 'platform' : 'own' })
    }
  }

  // 桌面 confirmReload:目标交给宿主,由它先写记录、再停、再起。失败留在确认这一步,可以再点一次。
  // 重开要好几秒,其间关掉的抽屉回来时也不重新弹开(同 pick)。
  const confirmReload = (): void => {
    if (!reload) return
    setPending('model')
    setError(null)
    void reloadSessionModel(deviceId, { conversationId: sessionId, model: reload.modelId, modelSource: reload.source }, phoneHost)
      .then((next) => { setOptions(next); setReload(null); setView((v) => v && root[0]) })
      .catch((err) => setError(describe(err)))
      .finally(() => setPending(null))
  }

  const close = (): void => {
    setView(null)
    setReload(null)
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="gg-aw-pill"
        disabled={disabled}
        data-testid="agent-watch-options-open"
        aria-haspopup="dialog"
        aria-expanded={view !== null}
        onClick={() => setView(root[0])}
      >
        <span className="gg-aw-pill-text">{label}</span>
        <ChevronDown />
      </Button>

      <Sheet
          open={Boolean(current)}
          onClose={close}
          mobileFitContent
          testId="agent-watch-options"
          ariaLabel={t(`agentWatch.options.${current?.[0] ?? root[0]}`)}
        >
          {current ? <div className="gg-aw gg-aw-sheet">
            {/* 头部三分栏:左 ✕/← 圆钮、中间标题、右侧留给 pending 转圈(orca 同款)。 */}
            <div className="gg-aw-sheet-head">
              <IconButton
                size="lg"
                className="gg-aw-sheet-nav"
                aria-label={atRoot ? t('agentWatch.options.close') : t('agentWatch.options.back')}
                data-testid="agent-watch-options-nav"
                onClick={() => (atRoot ? close() : setView(root[0]))}
              >
                {atRoot ? <X /> : <ChevronLeft />}
              </IconButton>
              <div className="gg-aw-sheet-title">
                {t('agentWatch.options.pick', { name: t(`agentWatch.options.${current?.[0] ?? root[0]}`) })}
              </div>
              <div className="gg-aw-sheet-side">
                {pending !== null ? (
                  <span className="gg-aw-sheet-spinner" data-testid="agent-watch-options-pending" />
                ) : null}
              </div>
            </div>

            {error ? (
              <div
                className="gg-aw-sheet-caption"
                data-tone="error"
                data-testid="agent-watch-options-error"
              >
                {error.message}
              </div>
            ) : null}

            {reload ? (
              // 与桌面确认框同一套话:标题「换成 X?」、代价那一句、「打断并切换」。
              <div className="gg-aw-actions" data-testid="agent-watch-options-reload">
                <div className="gg-aw-actions-title">
                  {translateSessionMessage(pending ? 'chat.reloadInProgress' : 'chat.reloadConfirmTitleModel', { target: reload.label })}
                </div>
                <div className="gg-aw-actions-note">{translateSessionMessage('chat.reloadConfirmBody')}</div>
                <Button
                  variant="primary"
                  size="lg"
                  className="gg-aw-actions-item"
                  disabled={pending !== null}
                  data-testid="agent-watch-options-reload-confirm"
                  onClick={confirmReload}
                >
                  {translateSessionMessage('chat.reloadConfirmActionSwitch')}
                </Button>
                <Button variant="secondary" size="lg" className="gg-aw-actions-item" disabled={pending !== null} onClick={() => setReload(null)}>
                  {translateSessionMessage('common.cancel')}
                </Button>
              </div>
            ) : current[0] === 'model' && models ? (
              <div className="gg-aw-choice-group" role="radiogroup" data-dimension="model">
                {models.groups.map((group) => (
                  <div key={group.items[0]?.id} className="gg-aw-choice-section">
                    {group.label ? <div className="gg-aw-choice-section-title">{group.label}</div> : null}
                    {group.items.map((item) => (
                      <ChoiceRow
                        key={item.id}
                        dimension="model"
                        id={item.id}
                        name={item.name}
                        desc={item.disabledReason ?? item.description}
                        selected={item.id === models.selectedId}
                        disabled={disabled || item.disabled === true}
                        onPick={() => pickModel(item.id)}
                      />
                    ))}
                  </div>
                ))}
                <ModelMenuFooter lockedModels={models.lockedModels} onLeave={close} />
              </div>
            ) : (
              <div className="gg-aw-choice-group" role="radiogroup" data-dimension={current[0]}>
                {currentChoices?.choices.map((choice) => (
                  <ChoiceRow
                    key={choice.id}
                    dimension={current[0]}
                    id={choice.id}
                    name={choice.name}
                    desc={choice.description}
                    selected={choice.id === currentChoices.selected}
                    disabled={disabled}
                    onPick={() => pick(current[0], current[1], choice.id)}
                  />
                ))}
              </div>
            )}

            {/* 顶层才列「其余档位」:一行一档,带当前值和 ›,点进去换成那一档。 */}
            {atRoot && others.length > 0 && !reload ? (
              <div className="gg-aw-summary-group">
                {others.map(([dimension, group]) => (
                  <Button
                    key={dimension}
                    variant="ghost"
                    size="option"
                    className="gg-aw-summary"
                    disabled={disabled}
                    data-testid="agent-watch-options-drill"
                    data-dimension={dimension}
                    onClick={() => setView(dimension)}
                  >
                    <span className="gg-aw-summary-label">{t(`agentWatch.options.${dimension}`)}</span>
                    <span className="gg-aw-summary-value">
                      {selectedName(dimension, group, modeMap) ?? t('agentWatch.options.unknownValue')}
                    </span>
                    <ChevronRight />
                  </Button>
                ))}
              </div>
            ) : null}
          </div> : null}
        </Sheet>
    </>
  )
}

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  guguCatalogReasonKind,
  type SessionpageSessionCreateModels,
  type SessionpageSessionCreateOptions,
} from '@gugu/session-core/session-record/contract'
import { Check, ChevronDown, ChevronLeft, ChevronRight, X } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Sheet } from '@/components/ui/Sheet'
import {
  createPillLabel,
  harnessBlockReason,
  harnessUsable,
  selectHarness,
  selectedEffortName,
  selectedModelName,
  type CreateSelection,
} from './create-session-form'
import { createModelOptions } from './session-model-menu'
import { allGuguHidden, offeredInCreateMenu } from '@/lib/createModelDefault'
import { ModelMenuFooter } from './ModelMenuFooter'
import { composerTierLabel } from '@renderer/features/sessions/session-config/use-composer-model-options'
import { guguReasonText } from '@renderer/features/sessions/gugu-reason'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import './task-flow-catalog'

/**
 * 新建会话的「项目 · harness」胶囊 —— 与会话页那颗选项胶囊(SessionOptionsPill)**同一形制**:
 * 摆在输入框那一行、只写值、抽屉下钻(顶层 = 项目,摘要行进 harness)、填满圆点打勾。
 * 两颗胶囊长得一样是有意的:在人眼里它们是同一个东西 —— 「说这句话之前先定个调」。
 *
 * 选完**不关**(两颗同一条,owner 10-07「调完一个设置后还可以继续调另一个,而不是每次都要重新点开设置」):
 * 在下钻页选 → 回顶层,摘要行上就是刚改的值,接着点下一项;在顶层选(项目)→ 留在顶层、勾移过去。
 * 关只靠 ✕ 和点遮罩。
 *
 * 与那颗的差别只有一处:这里的选择**只在手机上**,发送时才随请求带过去,❌ 不逐项下发到机器 ——
 * 会话还不存在,机器上没有可改的东西。
 *
 * 不能用的 harness **照列不藏**,行上写明是「没装」「装了但坏了」还是「手机端读不了它的记录」,但点不动:
 * 藏掉的话人只看到一个短列表,说不出为什么想用的那家不在。
 */
export function CreateOptionsPill({
  options,
  selection,
  onChange,
  busy,
  models,
  modelsState,
  phoneHost = false,
}: {
  options: SessionpageSessionCreateOptions
  selection: CreateSelection
  /** 模型点选另报，区分“明确不指定”和尚未定默认；改项目/权限不算选过模型。 */
  onChange: (next: CreateSelection, modelPicked?: boolean) => void
  /** 正在建 —— 发出去之后再改项目,请求已经带着旧值在路上了。 */
  busy: boolean
  /** 选定 harness 的模型目录;还没到 / 探失败时 null,由 `modelsState` 说明是哪种。 */
  models: SessionpageSessionCreateModels | null
  modelsState: 'idle' | 'loading' | 'ready' | 'failed'
  phoneHost?: boolean
}) {
  const { t } = useTranslation('main')
  const { t: tFlow } = useTranslation('mobileTaskFlow')
  const [view, setView] = useState<'project' | 'harness' | 'permission' | 'model' | 'effort' | null>(null)
  const harnessOption = options.harnesses.find((h) => h.id === selection.harness) ?? null
  const label = createPillLabel(options, selection, models, phoneHost ? tFlow('phoneAgent') : undefined)

  // 一个值都没有就整个不画(与会话选项胶囊同一条):机器上没项目、也没 harness 的情形,
  // 页面正文已经在说原因了,这里再摆一个空胶囊只会多一个「这是啥」。
  if (!label) return null

  const atRoot = view === (phoneHost ? 'model' : 'project')
  const backToRoot = () => setView(phoneHost ? 'model' : 'project')

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="gg-aw-pill"
        disabled={busy}
        data-testid="agent-watch-create-options-open"
        aria-haspopup="dialog"
        aria-expanded={view !== null}
        onClick={() => setView(phoneHost ? 'model' : 'project')}
      >
        <span className="gg-aw-pill-text">{label}</span>
        <ChevronDown />
      </Button>

      <Sheet
          open={view !== null}
          onClose={() => setView(null)}
          mobileFitContent
          testId="agent-watch-create-options"
          ariaLabel={t(`agentWatch.create.${view === 'permission' ? 'permissionLabel' : view ?? 'project'}`)}
        >
          {view ? <div className="gg-aw gg-aw-sheet">
            <div className="gg-aw-sheet-head">
              <IconButton
                size="lg"
                className="gg-aw-sheet-nav"
                aria-label={atRoot ? t('agentWatch.options.close') : t('agentWatch.options.back')}
                data-testid="agent-watch-create-options-nav"
                onClick={() => (atRoot ? setView(null) : backToRoot())}
              >
                {atRoot ? <X /> : <ChevronLeft />}
              </IconButton>
              <div className="gg-aw-sheet-title">
                {t('agentWatch.options.pick', { name: t(`agentWatch.create.${view === 'permission' ? 'permissionLabel' : view ?? 'project'}`) })}
              </div>
              <div className="gg-aw-sheet-side" />
            </div>

            {view === 'permission' ? (
              <ChoiceList
                dimension="permission"
                defaultChoice={{ name: t('agentWatch.create.modelDefault'), desc: t('agentWatch.create.permissionDefaultHint') }}
                choices={(harnessOption?.permissionModes ?? []).map((m) => ({
                  id: m,
                  name: t(`agentWatch.create.permission.${m}.name`),
                  desc: t(`agentWatch.create.permission.${m}.desc`),
                }))}
                selected={selection.permissionMode}
                onPick={(id) => {
                  onChange({ ...selection, permissionMode: id as CreateSelection['permissionMode'] })
                  backToRoot()
                }}
              />
            ) : view === 'effort' ? (
              <ChoiceList
                dimension="effort"
                defaultChoice={{ name: t('agentWatch.create.modelDefault'), desc: t('agentWatch.create.effortDefaultHint') }}
                choices={(models?.efforts ?? []).map((e) => ({ id: e.id, name: e.name, desc: e.description }))}
                selected={selection.effort}
                onPick={(id) => {
                  onChange({ ...selection, effort: id })
                  backToRoot()
                }}
              />
            ) : view === 'model' ? (
              <ModelChoices
                models={models}
                platformOnly={phoneHost || harnessOption?.chatAvailable === true && !harnessOption.watchable}
                harnessName={phoneHost ? tFlow('phoneAgent') : harnessOption?.name ?? selection.harness ?? ''}
                defaultHint={phoneHost ? tFlow('phoneModelDefaultHint') : undefined}
                state={modelsState}
                selection={selection}
                onPick={(model) => {
                  onChange({ ...selection, model }, true)
                  backToRoot()
                }}
                onLeave={() => setView(null)}
              />
            ) : view === 'project' ? (
              <div className="gg-aw-choice-group" role="radiogroup" data-dimension="project">
                {options.projects.map((project) => {
                  const selected = project.id === selection.projectId
                  return (
                    <Button
                      key={project.id}
                      variant="ghost"
                      size="option"
                      className="gg-aw-choice"
                      role="radio"
                      aria-checked={selected}
                      data-testid="agent-watch-create-choice"
                      data-dimension="project"
                      data-option-id={project.id}
                      onClick={() => onChange({ ...selection, projectId: project.id })}
                    >
                      <span className="gg-aw-choice-radio" data-on={selected ? 'true' : undefined}>
                        {selected ? <Check /> : null}
                      </span>
                      <span className="gg-aw-choice-body">
                        <span className="gg-aw-choice-label">{project.name}</span>
                        {!harnessOption?.chatAvailable || harnessOption.watchable ? <span className="gg-aw-choice-desc">{project.path}</span> : null}
                      </span>
                    </Button>
                  )
                })}
              </div>
            ) : (
              <div className="gg-aw-choice-group" role="radiogroup" data-dimension="harness">
                {options.harnesses.map((harness) => {
                  const selected = harness.id === selection.harness
                  const usable = harnessUsable(harness)
                  const reason = harnessBlockReason(harness)
                  return (
                    <Button
                      key={harness.id}
                      variant="ghost"
                      size="option"
                      className="gg-aw-choice"
                      role="radio"
                      aria-checked={selected}
                      disabled={!usable}
                      data-testid="agent-watch-create-choice"
                      data-dimension="harness"
                      data-option-id={harness.id}
                      data-status={harness.status}
                      onClick={() => {
                        // 换 harness 会把模型、推理档等重置成那一家的(selectHarness);回顶层后摘要行读的就是新的。
                        onChange(selectHarness(selection, harness.id, options))
                        backToRoot()
                      }}
                    >
                      <span className="gg-aw-choice-radio" data-on={selected ? 'true' : undefined}>
                        {selected ? <Check /> : null}
                      </span>
                      <span className="gg-aw-choice-body">
                        <span className="gg-aw-choice-label">{harness.name}</span>
                        {reason ? (
                          <span className="gg-aw-choice-desc">
                            {t(`agentWatch.create.harnessStatus.${reason}`)}
                          </span>
                        ) : null}
                      </span>
                    </Button>
                  )
                })}
              </div>
            )}

            {atRoot ? (
              <div className="gg-aw-summary-group">
                {!phoneHost && <Button
                  variant="ghost"
                  size="option"
                  className="gg-aw-summary"
                  data-testid="agent-watch-create-options-drill"
                  data-dimension="harness"
                  onClick={() => setView('harness')}
                >
                  <span className="gg-aw-summary-label">{t('agentWatch.create.harness')}</span>
                  <span className="gg-aw-summary-value">
                    {harnessOption?.name ?? t('agentWatch.options.unknownValue')}
                  </span>
                  <ChevronRight />
                </Button>}
                {/* 展示(编程/通用)不在这里选:那台电脑按自己的「终端」开关定。 */}
                {/* 权限档:这家声明了才摆(桌面同一条:不摆不存在的档)。 */}
                {!phoneHost && harnessOption && harnessOption.permissionModes.length > 0 ? (
                  <SummaryRow
                    dimension="permission"
                    label={t('agentWatch.options.mode')}
                    value={selection.permissionMode
                      ? t(`agentWatch.create.permission.${selection.permissionMode}.name`)
                      : t('agentWatch.create.modelDefault')}
                    onClick={() => setView('permission')}
                  />
                ) : null}
                {/* 模型一行:harness 选定后才有意义;写「默认」而不是留空 —— 不指定本身就是一个明确的选择。 */}
                {!phoneHost && <Button
                  variant="ghost"
                  size="option"
                  className="gg-aw-summary"
                  data-testid="agent-watch-create-options-drill"
                  data-dimension="model"
                  disabled={!selection.harness}
                  onClick={() => setView('model')}
                >
                  <span className="gg-aw-summary-label">{t('agentWatch.create.model')}</span>
                  <span className="gg-aw-summary-value">
                    {selectedModelName(models, selection)
                      ?? (modelsState === 'loading'
                        ? t('agentWatch.create.modelLoading')
                        : t('agentWatch.create.modelDefault'))}
                  </span>
                  <ChevronRight />
                </Button>}
                {/* 推理档:引擎不声明就不摆。 */}
                {models && models.efforts.length > 0 ? (
                  <SummaryRow
                    dimension="effort"
                    label={t('agentWatch.options.effort')}
                    value={selectedEffortName(models, selection) ?? t('agentWatch.create.modelDefault')}
                    onClick={() => setView('effort')}
                  />
                ) : null}
              </div>
            ) : null}
          </div> : null}
        </Sheet>
    </>
  )
}

function SummaryRow({
  dimension,
  label,
  value,
  onClick,
}: {
  dimension: string
  label: string
  value: string
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="option"
      className="gg-aw-summary"
      data-testid="agent-watch-create-options-drill"
      data-dimension={dimension}
      onClick={onClick}
    >
      <span className="gg-aw-summary-label">{label}</span>
      <span className="gg-aw-summary-value">{value}</span>
      <ChevronRight />
    </Button>
  )
}

/** 一维的单选列表:可选的「默认」行在最前(表示不指定、交给那一家),然后是各选项。 */
function ChoiceList({
  dimension,
  choices,
  selected,
  defaultChoice,
  onPick,
}: {
  dimension: string
  choices: Array<{ id: string; name: string; desc?: string }>
  selected: string | null
  defaultChoice?: { name: string; desc: string }
  onPick: (id: string | null) => void
}) {
  const rows: Array<{ id: string | null; name: string; desc?: string }> = defaultChoice
    ? [{ id: null, ...defaultChoice }, ...choices]
    : choices
  return (
    <div className="gg-aw-choice-group" role="radiogroup" data-dimension={dimension}>
      {rows.map((row) => {
        const isSelected = selected === row.id
        return (
          <Button
            key={row.id ?? '__default__'}
            variant="ghost"
            size="option"
            className="gg-aw-choice"
            role="radio"
            aria-checked={isSelected}
            data-testid="agent-watch-create-choice"
            data-dimension={dimension}
            data-option-id={row.id ?? ''}
            onClick={() => onPick(row.id)}
          >
            <span className="gg-aw-choice-radio" data-on={isSelected ? 'true' : undefined}>
              {isSelected ? <Check /> : null}
            </span>
            <span className="gg-aw-choice-body">
              <span className="gg-aw-choice-label">{row.name}</span>
              {row.desc ? <span className="gg-aw-choice-desc">{row.desc}</span> : null}
            </span>
          </Button>
        )
      })}
    </div>
  )
}

/**
 * 模型那一页:第一行永远是「默认(让 harness 自己定)」,然后 harness 自家一组、咕咕平台一组
 * (与桌面下拉同序)。哪一组缺席就在组名下写机器报来的原因,❌ 不藏:空列表说不出「为什么空」。
 */
function ModelChoices({
  models,
  platformOnly = false,
  harnessName,
  defaultHint,
  state,
  selection,
  onPick,
  onLeave,
}: {
  models: SessionpageSessionCreateModels | null
  platformOnly?: boolean
  /** 「你的 X 模型」的 X。 */
  harnessName: string
  defaultHint?: string
  state: 'idle' | 'loading' | 'ready' | 'failed'
  selection: CreateSelection
  onPick: (model: string | null) => void
  /** 底部「管理模型」去设置之前收起这张面板。 */
  onLeave: () => void
}) {
  const { t } = useTranslation('main')
  // 组头、倍率与桌面模型菜单同一份装配(session-model-menu)。
  const options = models ? createModelOptions(models, harnessName) : {}
  // 组空时写什么:harness 那组按探测状态措辞(状态码 ❌ 不给人看),`unavailable` 再附机器原话;
  // 咕咕那组机器报的是原因码,按界面语言说(老版本机器送来的原文认成「暂时用不了」,❌ 原样写)。
  const harnessEmptyText = (m: SessionpageSessionCreateModels): string => {
    const base = t(`agentWatch.create.modelHarnessState.${m.harnessState}`)
    return m.harnessState === 'unavailable' && m.harnessReason ? `${base}:${m.harnessReason}` : base
  }
  const guguEmptyText = (raw: string | null | undefined): string | null => {
    const kind = guguCatalogReasonKind(raw)
    return kind ? guguReasonText(kind, translateSessionMessage) : null
  }
  const groups: Array<{ source: 'harness' | 'gugu'; reason: string | null }> = [
    { source: 'harness', reason: models ? harnessEmptyText(models) : null },
    { source: 'gugu', reason: guguEmptyText(models?.guguReason) },
  ]
  const choice = (id: string | null, name: string, desc?: string, extra?: Record<string, string>) => {
    const selected = selection.model === id
    return (
      <Button
        key={id ?? '__default__'}
        variant="ghost"
        size="option"
        className="gg-aw-choice"
        role="radio"
        aria-checked={selected}
        data-testid="agent-watch-create-choice"
        data-dimension="model"
        data-option-id={id ?? ''}
        {...extra}
        onClick={() => onPick(id)}
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
  return (
    <div className="gg-aw-choice-group" role="radiogroup" data-dimension="model" data-state={state}>
      {choice(null, t('agentWatch.create.modelDefault'), defaultHint ?? t('agentWatch.create.modelDefaultHint'))}
      {state === 'loading' ? (
        <div className="gg-aw-choice-desc gg-aw-choice-note" data-testid="agent-watch-create-models-note">
          {t('agentWatch.create.modelLoading')}
        </div>
      ) : state === 'failed' ? (
        <div className="gg-aw-choice-desc gg-aw-choice-note" data-testid="agent-watch-create-models-note">
          {t('agentWatch.create.modelFailed')}
        </div>
      ) : null}
      {models
        ? groups.filter(({ source }) => !platformOnly || source === 'gugu').map(({ source, reason }) => {
            // 只列点得中、跑得起来的:要会员的、他在设置里关掉的都不列(#7056,与桌面下拉同一个判据)。
            const rows = models.models.filter((m) => m.source === source && offeredInCreateMenu(m))
            return (
              <div key={source} className="gg-aw-choice-section" data-source={source}>
                <div className="gg-aw-choice-section-title">
                  {composerTierLabel(source === 'gugu' ? 'platform' : 'own', harnessName)}
                </div>
                {rows.length > 0
                  ? rows.map((m) => choice(m.id, options[m.id]?.name ?? m.name, options[m.id]?.description, { 'data-source': m.source }))
                  : (
                    <div className="gg-aw-choice-desc gg-aw-choice-note" data-testid="agent-watch-create-models-empty" data-source={source}>
                      {source === 'gugu' && allGuguHidden(models)
                        ? t('agentWatch.create.modelGuguAllHidden')
                        : (reason ?? t('agentWatch.create.modelNone'))}
                    </div>
                  )}
              </div>
            )
          })
        : null}
      {models ? (
        <ModelMenuFooter
          lockedModels={models.models.filter((m) => m.source === 'gugu' && m.requires_membership).map((m) => m.name)}
          onLeave={onLeave}
        />
      ) : null}
    </div>
  )
}

import type { CSSProperties } from 'react'

export function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

const pop = 'animate-[gg-as-pop_var(--dur-fast)_var(--ease)]'

const tabBase =
  'gg-as-tab flex w-full cursor-pointer items-center gap-[11px] rounded-[var(--radius-xl)] border-0 text-left text-[length:var(--font-body)] font-[500] text-[var(--fg)] !px-3 !py-[9px] [&_svg]:shrink-0 [&_svg]:text-[var(--muted-fg)] [&_.gg-as-tab-chev]:!ml-auto [&_.gg-as-tab-chev]:transition-transform [&_.gg-as-tab-chev]:duration-[var(--dur-med)] [&_.gg-as-tab-chev]:[transition-timing-function:var(--ease)] [&_.gg-as-il]:block [&_.gg-as-if]:hidden'
const tabInactive = 'bg-transparent hover:bg-[var(--hover)] active:bg-[var(--press)]'
const tabActive =
  'gg-as-tab--on bg-[var(--bg)] [box-shadow:inset_0_0_0_1px_var(--border-strong)] [&_.gg-as-il]:!hidden [&_.gg-as-if]:!block'
const tabSub = 'gg-as-sub text-[length:var(--font-body)] !px-[11px] !py-[7px]'

const financePillBase =
  'gg-as-finance-pill cursor-pointer rounded-[var(--radius-capsule)] border text-[length:var(--font-body)] !px-[14px] !py-1.5'
const financePillInactive =
  'border-[var(--border-strong)] bg-transparent text-[var(--muted-fg)]'
const financePillActive =
  'gg-as-finance-pill--on border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]'

const historyToggleBase =
  'gg-as-history-tgl relative !mt-0.5 h-[22px] w-[38px] shrink-0 cursor-pointer rounded-[var(--radius-capsule)] border-0 !p-0 transition-[background] duration-[var(--dur-fast)] [transition-timing-function:var(--ease)] after:absolute after:left-0.5 after:top-0.5 after:h-[18px] after:w-[18px] after:rounded-[var(--radius-capsule)] after:bg-[var(--color-white)] after:content-[""] after:transition-transform after:duration-[var(--dur-fast)] after:[transition-timing-function:var(--ease)]'
const historyToggleInactive = '![background:var(--border-strong)]'
const historyToggleActive =
  'gg-as-history-tgl--on ![background:var(--primary)] after:[transform:translateX(16px)]'

const shareSegmentButtonBase =
  'gg-as-share-act-seg-btn flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius-control)] border-0 text-[length:var(--font-body)] font-[500] !p-2'
const shareSegmentButtonInactive =
  'bg-transparent text-[var(--muted-fg)]'
const shareSegmentButtonActive =
  'gg-as-share-act-seg-btn--on bg-[var(--bg)] text-[var(--fg)] [box-shadow:0_1px_3px_#0000001a]'

const memoryFileBase =
  'gg-as-memory-wd-f flex cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-[var(--radius-control)] text-[length:var(--font-body)] text-[var(--fg)] !px-2 !py-1.5 [&_svg]:shrink-0 [&_svg]:text-[var(--muted-fg)]'
const memoryFileInactive = 'bg-transparent hover:bg-[var(--hover)] active:bg-[var(--press)]'
const memoryFileActive = 'gg-as-memory-wd-f--on bg-[var(--hover)]'

const profileInputBase =
  'gg-as-profile-input box-border w-full rounded-[var(--radius-xl)] border border-[var(--border-strong)] outline-none !px-3 !py-2.5 focus:border-[var(--primary)]'
const profileInputDefault =
  'bg-[var(--bg)] text-[length:var(--font-body)] text-[var(--fg)]'
const profileInputReadonly =
  'gg-as-profile-input--ro bg-[var(--muted)] font-mono text-[length:var(--font-body)] text-[var(--muted-fg)]'
const profileInputTextarea =
  'gg-as-profile-input--ta min-h-[84px] resize-none leading-[1.5]'

export const asClass = {
  scrim: 'gg-as-scrim fixed inset-0 z-[500] flex items-center justify-center bg-[#00000040]',
  modal:
    'gg-as-modal flex h-[580px] max-h-[88vh] w-[880px] max-w-[93vw] flex-col overflow-hidden rounded-[var(--radius-dialog)] bg-[var(--bg)] shadow-[var(--shadow-dialog)] animate-[gg-as-pop_var(--dur-med)_var(--ease)]',
  top: 'gg-as-top flex shrink-0 items-center gap-[11px] border-b border-[var(--border)] !px-5 !py-[17px]',
  topAvatar: 'gg-as-av av ag',
  // 名字 + 状态同一块:放得下就同一行,放不下状态落到名字下一行;名字只占一行、截断(全名在「资料」里)。
  titleBlock: 'gg-as-title flex min-w-0 flex-1 flex-wrap items-center gap-x-[11px] gap-y-0.5',
  name: 'gg-as-name min-w-0 max-w-full truncate text-[length:var(--font-title)] font-semibold',
  status:
    'gg-as-status flex min-w-0 items-center gap-[5px] text-[length:var(--font-body)] text-[var(--muted-fg)] before:h-1.5 before:w-1.5 before:shrink-0 before:rounded-[var(--radius-capsule)] before:[background:var(--green)] before:content-[""] data-[offline]:before:[background:var(--faint-fg)]',
  close:
    'gg-as-close !ml-auto grid h-[30px] w-[30px] cursor-pointer place-items-center rounded-[var(--radius-control)] border-0 bg-transparent text-[var(--muted-fg)] hover:bg-[var(--hover)] hover:text-[var(--fg)]',
  main: 'gg-as-main flex min-h-0 flex-1',
  rail:
    'gg-as-rail flex w-[190px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--border)] !px-3 !py-[14px]',
  subs:
    'gg-as-subs flex-col gap-0.5 border-l border-[var(--border)] !my-0.5 !ml-[15px] !mr-0 !pl-[9px]',
  subsHidden: 'hidden',
  subsVisible: `gg-as-subs--on flex ${pop}`,
  settingsToggle: 'gg-as-settings-toggle',
  settingsToggleExpanded:
    'gg-as-settings-toggle--expanded [&_.gg-as-tab-chev]:[transform:rotate(180deg)]',
  body: 'gg-as-body min-w-0 flex-1 overflow-y-auto !px-7 !py-6',
  paneHidden: 'gg-as-pane hidden',
  paneVisible: `gg-as-pane gg-as-pane--on block ${pop}`,

  profileField: 'gg-as-profile-field !mb-[17px]',
  profileLabel:
    'gg-as-profile-label !mb-[7px] text-[length:var(--font-body)] font-[500] text-[var(--faint-fg)]',
  profileRow: 'gg-as-profile-row flex items-center gap-[14px] !mb-5',
  profileAvatar:
    'gg-as-profile-av h-[52px] w-[52px] shrink-0 overflow-hidden rounded-[var(--radius-capsule)] bg-[var(--muted)] [&_img]:block [&_img]:h-full [&_img]:w-full [&_img]:object-cover',
  profileAprField: 'gg-as-profile-apr-field flex-1',
  // 右侧下拉箭头是绝对定位的:输入框右内边距要给它留位,否则长名字的尾巴钻到箭头底下。
  profileNameWrap: 'gg-as-profile-name-wrap relative [&>input]:!pr-8',
  profileNameChevron:
    'gg-as-profile-name-chev pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--faint-fg)]',
  profileError: 'gg-as-profile-error !mt-1.5 text-[length:var(--font-body)] text-[var(--danger)]',
  profileSave:
    'gg-as-profile-save float-right cursor-pointer rounded-[var(--radius-xl)] border-0 bg-[var(--primary)] text-[length:var(--font-body)] font-semibold text-[var(--primary-fg)] !px-[26px] !py-2.5 hover:opacity-[.88] disabled:cursor-default disabled:opacity-50',
  profileDanger:
    'gg-as-profile-danger clear-both !mt-11 w-full cursor-pointer rounded-[var(--radius-xl)] border-0 bg-[var(--danger-tint)] text-[length:var(--font-body)] font-[500] text-[var(--danger)] !p-3 hover:bg-[var(--danger-tint-press)] disabled:cursor-default disabled:opacity-50',

  financeTitle: 'gg-as-finance-title text-[16px] font-semibold',
  financeSub: 'gg-as-finance-sub !mt-[3px] text-[length:var(--font-body)] text-[var(--muted-fg)]',
  financePills: 'gg-as-finance-pills flex gap-[7px] !mb-5 !mt-4',
  financeH2:
    'gg-as-finance-h2 !mb-0.5 !mt-0 text-[length:var(--font-caption)] font-semibold uppercase tracking-[.05em] text-[var(--muted-fg)]',
  financeGrid: 'gg-as-finance-grid !mt-2.5 grid grid-cols-2 gap-[14px]',
  financeCard: 'gg-as-finance-card rounded-[var(--radius-xl)] border border-[var(--border)] !p-4',
  financeCardLabel: 'gg-as-finance-fc-l text-[length:var(--font-body)] text-[var(--muted-fg)]',
  financeCardValue: 'gg-as-finance-fc-v !my-[9px] text-[25px] font-semibold',
  financeCardDesc: 'gg-as-finance-fc-d text-[length:var(--font-body)] leading-[1.5] text-[var(--faint-fg)]',

  historyRow:
    'gg-as-history-row flex items-start justify-between gap-4 border-b border-[var(--border)] !px-0 !py-[15px]',
  historyArl: 'gg-as-history-arl text-[length:var(--font-body)] font-[500]',
  historyArd: 'gg-as-history-ard !mt-[3px] max-w-[400px] text-[length:var(--font-body)] leading-[1.5] text-[var(--faint-fg)]',
  historyH2:
    'gg-as-history-h2 !mb-1 !mt-[22px] text-[length:var(--font-caption)] font-semibold tracking-[.02em] text-[var(--faint-fg)]',
  historyHrow: 'gg-as-history-hrow flex items-center gap-[11px] border-b border-[var(--border)] !px-0 !py-3',
  historyAvatar:
    'gg-as-history-hh-av h-[30px] w-[30px] shrink-0 overflow-hidden rounded-[var(--radius-capsule)] bg-[var(--muted)] [&_img]:h-full [&_img]:w-full [&_img]:object-cover',
  historyAvatarPlaceholder: 'gg-as-history-hh-av-placeholder h-full w-full bg-[var(--muted)]',
  historyText: 'gg-as-history-hh-t min-w-0 flex-1',
  historyName: 'gg-as-history-hh-n text-[length:var(--font-body)] font-[500]',
  historyDesc:
    'gg-as-history-hh-d !mt-px overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--font-body)] text-[var(--faint-fg)]',
  historyDone: 'gg-as-history-hh-done shrink-0 text-[length:var(--font-caption)] text-[#16a34a]',

  tasksH2:
    'gg-as-tasks-h2 !mb-1 !mt-[22px] text-[length:var(--font-caption)] font-semibold tracking-[.02em] text-[var(--faint-fg)]',
  tasksEmpty:
    'gg-as-tasks-empty flex flex-col items-center gap-[7px] text-[length:var(--font-body)] text-[var(--faint-fg)] !px-0 !py-16',
  tasksIconBox:
    'gg-as-tasks-ee !mb-1 grid h-[50px] w-[50px] place-items-center rounded-[var(--radius-xl)] bg-[var(--muted)]',
  tasksSub: 'gg-as-tasks-es text-[length:var(--font-body)]',

  contactsH2:
    'gg-as-contacts-h2 !mb-1 !mt-[22px] text-[length:var(--font-caption)] font-semibold tracking-[.02em] text-[var(--faint-fg)]',
  contactsHrow:
    'gg-as-contacts-hrow flex items-center gap-[11px] border-b border-[var(--border)] !px-0 !py-3',
  contactsAvatar:
    'gg-as-contacts-hh-av h-[30px] w-[30px] shrink-0 overflow-hidden rounded-[var(--radius-capsule)] bg-[var(--muted)] [&_img]:h-full [&_img]:w-full [&_img]:object-cover',
  contactsText: 'gg-as-contacts-hh-t min-w-0 flex-1',
  contactsName: 'gg-as-contacts-hh-n text-[length:var(--font-body)] font-[500]',
  contactsDesc:
    'gg-as-contacts-hh-d !mt-px overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--font-body)] text-[var(--faint-fg)]',

  shareRoot: 'gg-as-share-act-root',
  shareTitle: 'gg-as-share-act-title !mb-4 text-[16px] font-semibold',
  shareSegment: 'gg-as-share-act-seg flex rounded-[var(--radius-xl)] bg-[var(--muted)] !mb-3 !p-[3px]',
  shareFee:
    'gg-as-share-act-fee rounded-[var(--radius-capsule)] bg-[#f59e0b1f] text-[10px] font-semibold text-[#f59e0b] !px-1.5 !py-px',
  shareFwd: 'gg-as-share-act-fwd !px-0.5 !py-1.5',
  shareSearch: 'gg-as-share-act-search !mb-1.5',
  shareList: 'gg-as-share-act-list max-h-[260px] overflow-auto',
  shareRow:
    'gg-as-share-act-row flex cursor-pointer items-center gap-[11px] rounded-[var(--radius-xl)] !px-1.5 !py-[9px] hover:bg-[var(--hover)] active:bg-[var(--press)]',
  shareAvatar:
    'gg-as-share-act-av h-8 w-8 shrink-0 overflow-hidden rounded-[var(--radius-capsule)] bg-[var(--muted)]',
  shareRowName: 'gg-as-share-act-row-name text-[length:var(--font-body)] font-[500]',
  shareEmpty: 'gg-as-share-act-empty text-[length:var(--font-body)] text-[var(--faint-fg)] !px-1.5 !py-3',
  shareError: 'gg-as-share-act-error !mt-2 text-[length:var(--font-body)] text-[var(--danger)]',
  shareBusy: 'gg-as-share-act-busy !mt-2 text-[length:var(--font-body)] text-[var(--muted-fg)]',
  shareExt: 'gg-as-share-act-ext !px-0.5 !py-1.5',
  shareExtCard:
    'gg-as-share-act-se-card !mb-3 rounded-[var(--radius-xl)] border border-[var(--border)] text-center !p-[14px]',
  shareQr:
    'gg-as-share-act-se-qr !mx-auto !mb-2.5 h-24 w-24 rounded-xl [background:repeating-linear-gradient(45deg,var(--muted),var(--muted)_6px,var(--hover)_6px,var(--hover)_12px)]',
  shareQrImage: 'gg-as-share-act-se-qr bg-[var(--color-white)] object-contain',
  shareLink:
    'gg-as-share-act-se-link flex items-center gap-2 rounded-[var(--radius-xl)] border border-[var(--border-strong)] text-[length:var(--font-body)] text-[var(--muted-fg)] !px-[11px] !py-[9px] [&_span]:min-w-0 [&_span]:flex-1 [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap',
  shareCopy:
    'gg-as-share-act-se-copy shrink-0 cursor-pointer rounded-[var(--radius-control)] border-0 bg-[var(--primary)] text-[length:var(--font-body)] text-[var(--primary-fg)] !px-3 !py-[5px]',
  shareFeeText: 'gg-as-share-act-se-fee !mt-2.5 text-[length:var(--font-body)] text-[#f59e0b]',
  shareEnable:
    'gg-as-share-act-se-enable !mt-2.5 w-full cursor-pointer rounded-[var(--radius-control)] border-0 bg-[var(--primary)] text-[length:var(--font-body)] text-[var(--primary-fg)] !px-3 !py-2 disabled:cursor-default disabled:opacity-60',

  memoryLabel:
    'gg-as-memory-label !mb-[7px] text-[length:var(--font-body)] font-[500] text-[var(--faint-fg)]',
  memoryWd:
    'gg-as-memory-wd flex h-[300px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)]',
  memoryTree:
    'gg-as-memory-wd-tree w-[204px] shrink-0 overflow-y-auto border-r border-[var(--border)] !p-2',
  memoryView:
    'gg-as-memory-wd-view flex flex-1 items-center justify-center text-center text-[length:var(--font-body)] text-[var(--faint-fg)] !p-5',

  secretsHead: 'gg-as-secrets-head !mb-[14px] flex items-center justify-between',
  secretsH2:
    'gg-as-secrets-h2 !m-0 text-[length:var(--font-caption)] font-semibold tracking-[.02em] text-[var(--faint-fg)]',
  secretsButton:
    'gg-as-secrets-btn inline-flex cursor-pointer items-center gap-[5px] rounded-[var(--radius-xl)] border-0 bg-[var(--primary)] text-[length:var(--font-body)] font-[500] text-[var(--primary-fg)] !px-[13px] !py-[7px] hover:opacity-[.88]',
  secretsArd:
    'gg-as-secrets-ard !mb-3 text-[length:var(--font-body)] leading-[1.5] text-[var(--faint-fg)]',
  secretsEmpty:
    'gg-as-secrets-empty !mt-2 rounded-[var(--radius-xl)] border border-dashed border-[var(--border-strong)] text-center text-[length:var(--font-body)] text-[var(--faint-fg)] !px-0 !py-7',
  secretsEmptySub: 'gg-as-secrets-empty-sub !mt-1.5 text-[length:var(--font-caption)]',

  permissionsH2:
    'gg-as-permissions-h2 !mb-1 !mt-[22px] text-[length:var(--font-caption)] font-semibold tracking-[.02em] text-[var(--faint-fg)]',
  permissionsArd:
    'gg-as-permissions-ard text-[length:var(--font-body)] leading-[1.5] text-[var(--faint-fg)]',
  permissionsGrantCard:
    'gg-as-permissions-grant-card !mt-2 rounded-[var(--radius-xl)] border border-[var(--border)] !p-[15px]',
  permissionsArl: 'gg-as-permissions-arl text-[length:var(--font-body)] font-[500]',
  permissionsField: 'gg-as-permissions-field !mb-[17px]',
  permissionsLabel:
    'gg-as-permissions-label !mb-[7px] text-[length:var(--font-body)] font-[500] text-[var(--faint-fg)]',
  permissionsSelect:
    'gg-as-permissions-sel shrink-0 cursor-pointer rounded-[var(--radius-xl)] border border-[var(--border-strong)] text-[length:var(--font-body)] text-[var(--fg)] outline-none !py-2 !pl-3 !pr-[30px] [font-family:inherit] [appearance:none] focus:border-[var(--primary)]',
  permissionsSelectWide: 'gg-as-permissions-sel-wide box-border w-full',
  permissionsGrantDate:
    'gg-as-permissions-grant-date box-border w-full rounded-[var(--radius-xl)] border border-[var(--border-strong)] bg-[var(--bg)] text-[length:var(--font-body)] text-[var(--muted-fg)] !px-[11px] !py-[9px]',
  permissionsSave:
    'gg-as-permissions-save cursor-pointer rounded-[var(--radius-xl)] border-0 bg-[var(--primary)] text-[length:var(--font-body)] font-semibold text-[var(--primary-fg)] !px-[26px] !py-2.5 hover:opacity-[.88]',
  permissionsGrantEmpty:
    'gg-as-permissions-grant-empty !mt-2 rounded-[var(--radius-xl)] border border-dashed border-[var(--border-strong)] text-center text-[length:var(--font-body)] text-[var(--faint-fg)] !px-0 !py-7',

  aiModelLabel:
    'gg-as-aimodel-label !mb-[7px] text-[length:var(--font-body)] font-[500] text-[var(--faint-fg)]',
  aiModelSelect:
    'gg-as-aimodel-sel box-border w-full cursor-pointer rounded-[var(--radius-xl)] border border-[var(--border-strong)] text-[length:var(--font-body)] text-[var(--fg)] outline-none !py-2 !pl-3 !pr-[30px] [font-family:inherit] [appearance:none] focus:border-[var(--primary)] disabled:cursor-default disabled:opacity-60',
  aiModelArd: 'gg-as-aimodel-ard !mt-[9px] text-[length:var(--font-body)] leading-[1.5] text-[var(--faint-fg)]',
  aiModelSave:
    'gg-as-aimodel-save float-right !mt-4 cursor-pointer rounded-[var(--radius-xl)] border-0 bg-[var(--primary)] text-[length:var(--font-body)] font-semibold text-[var(--primary-fg)] !px-[26px] !py-2.5 hover:opacity-[.88] disabled:cursor-default disabled:opacity-50',

}

export function agentSettingsTabClass(active: boolean, extra?: string) {
  return cx(tabBase, active ? tabActive : tabInactive, extra)
}

export function agentSettingsSubTabClass(active: boolean) {
  return agentSettingsTabClass(active, tabSub)
}

export function agentSettingsSubsClass(expanded: boolean) {
  return cx(asClass.subs, expanded ? asClass.subsVisible : asClass.subsHidden)
}

export function agentSettingsPaneClass(active: boolean) {
  return active ? asClass.paneVisible : asClass.paneHidden
}

export function profileInputClass(mode: 'default' | 'readonly' | 'textarea' = 'default') {
  if (mode === 'readonly') return cx(profileInputBase, profileInputReadonly)
  if (mode === 'textarea') return cx(profileInputBase, profileInputDefault, profileInputTextarea)
  return cx(profileInputBase, profileInputDefault)
}

export function financePillClass(active: boolean) {
  return cx(financePillBase, active ? financePillActive : financePillInactive)
}

export function historyToggleClass(active: boolean) {
  return cx(historyToggleBase, active ? historyToggleActive : historyToggleInactive)
}

export function shareSegmentButtonClass(active: boolean) {
  return cx(shareSegmentButtonBase, active ? shareSegmentButtonActive : shareSegmentButtonInactive)
}

export function memoryFileClass(active: boolean) {
  return cx(memoryFileBase, active ? memoryFileActive : memoryFileInactive)
}

export const permissionsSelectStyle: CSSProperties = {
  background: 'var(--bg) url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="none" stroke="%2394a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 4.5 3 3 3-3"/></svg>\') no-repeat right 10px center',
}

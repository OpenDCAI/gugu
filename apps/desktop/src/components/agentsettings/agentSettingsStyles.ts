export function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

const pop = 'animate-[gg-as-pop_var(--dur-fast)_var(--ease)]'

const tabBase =
  'gg-as-tab flex w-full cursor-pointer items-center gap-[11px] rounded-[var(--radius-xl)] border-0 text-left text-[length:var(--font-body)] font-[500] text-[var(--fg)] !px-3 !py-[9px] [&_svg]:shrink-0 [&_svg]:text-[var(--muted-fg)] [&_.gg-as-tab-chev]:!ml-auto [&_.gg-as-tab-chev]:transition-transform [&_.gg-as-tab-chev]:duration-[var(--dur-med)] [&_.gg-as-tab-chev]:[transition-timing-function:var(--ease)] [&_.gg-as-il]:block [&_.gg-as-if]:hidden'
const tabInactive = 'bg-transparent hover:bg-[var(--hover)] active:bg-[var(--press)]'
const tabActive =
  'gg-as-tab--on bg-[var(--bg)] [box-shadow:inset_0_0_0_1px_var(--border-strong)] [&_.gg-as-il]:!hidden [&_.gg-as-if]:!block'

const shareSegmentButtonBase =
  'gg-as-share-act-seg-btn flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius-control)] border-0 text-[length:var(--font-body)] font-[500] !p-2'
const shareSegmentButtonInactive =
  'bg-transparent text-[var(--muted-fg)]'
const shareSegmentButtonActive =
  'gg-as-share-act-seg-btn--on bg-[var(--bg)] text-[var(--fg)] [box-shadow:0_1px_3px_#0000001a]'

const profileInputBase =
  'gg-as-profile-input box-border w-full rounded-[var(--radius-xl)] border border-[var(--border-strong)] outline-none !px-3 !py-2.5 focus:border-[var(--primary)]'
const profileInputDefault =
  'bg-[var(--bg)] text-[length:var(--font-body)] text-[var(--fg)]'
const profileInputReadonly =
  'gg-as-profile-input--ro bg-[var(--muted)] font-mono text-[length:var(--font-body)] text-[var(--muted-fg)]'
const profileInputTextarea =
  'gg-as-profile-input--ta min-h-[84px] resize-none leading-[1.5]'

export const asClass = {
  tasksHead: 'gg-as-tasks-head !mb-[14px] flex items-center justify-between',
  tasksSave: 'gg-as-profile-save float-right cursor-pointer rounded-[var(--radius-xl)] border-0 bg-[var(--primary)] text-[length:var(--font-body)] font-semibold text-[var(--primary-fg)] !px-[26px] !py-2.5 hover:opacity-[.88] disabled:cursor-default disabled:opacity-50',
  tasksHeading: 'gg-as-tasks-h2 !m-0 text-[length:var(--font-caption)] font-semibold tracking-[.02em] text-[var(--faint-fg)]',
  tasksAddButton: 'gg-as-tasks-btn inline-flex cursor-pointer items-center gap-[5px] rounded-[var(--radius-xl)] border-0 bg-[var(--primary)] text-[length:var(--font-body)] font-[500] text-[var(--primary-fg)] !px-[13px] !py-[7px] hover:opacity-[.88]',
  tasksLoading: 'gg-as-tasks-empty !mt-2 rounded-[var(--radius-xl)] border border-dashed border-[var(--border-strong)] text-center text-[length:var(--font-body)] text-[var(--faint-fg)] !px-0 !py-7',
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
  profileError: 'gg-as-profile-error !mt-1.5 text-[length:var(--font-body)] text-[var(--danger-fg)]',
  tasksH2:
    'gg-as-tasks-h2 !mb-1 !mt-[22px] text-[length:var(--font-caption)] font-semibold tracking-[.02em] text-[var(--faint-fg)]',
  tasksEmpty:
    'gg-as-tasks-empty flex flex-col items-center gap-[7px] text-[length:var(--font-body)] text-[var(--faint-fg)] !px-0 !py-16',
  tasksIconBox:
    'gg-as-tasks-ee !mb-1 grid h-[50px] w-[50px] place-items-center rounded-[var(--radius-xl)] bg-[var(--muted)]',
  tasksSub: 'gg-as-tasks-es text-[length:var(--font-body)]',

  shareRoot: 'gg-as-share-act-root',
  shareTitle: 'gg-as-share-act-title !mb-4 text-[16px] font-semibold',
  shareSegment: 'gg-as-share-act-seg flex rounded-[var(--radius-xl)] bg-[var(--muted)] !mb-3 !p-[3px]',
  shareFwd: 'gg-as-share-act-fwd !px-0 !py-0',
  shareSearch: 'gg-as-share-act-search !mb-1.5',
  shareList: 'gg-as-share-act-list max-h-[260px] overflow-auto',
  shareRow:
    'gg-as-share-act-row flex cursor-pointer items-center gap-[11px] rounded-[var(--radius-xl)] !px-1.5 !py-[9px] hover:bg-[var(--hover)] active:bg-[var(--press)]',
  shareAvatar:
    'gg-as-share-act-av h-8 w-8 shrink-0 overflow-hidden rounded-[var(--radius-capsule)] bg-[var(--muted)]',
  shareRowName: 'gg-as-share-act-row-name text-[length:var(--font-body)] font-[500]',
  shareEmpty: 'gg-as-share-act-empty text-[length:var(--font-body)] text-[var(--faint-fg)] !px-0 !py-3',
  shareError: 'gg-as-share-act-error !mt-2 text-[length:var(--font-body)] text-[var(--danger-fg)]',
  shareBusy: 'gg-as-share-act-busy !mt-2 text-[length:var(--font-body)] text-[var(--muted-fg)]',
  shareExt: 'gg-as-share-act-ext !px-0.5 !py-1.5',
  shareExtCard:
    'gg-as-share-act-se-card !mb-3 rounded-[var(--radius-xl)] border border-[var(--border)] text-center !p-[14px]',
  shareQr:
    'gg-as-share-act-se-qr !mx-auto !mb-2.5 h-24 w-24 rounded-xl [background:repeating-linear-gradient(45deg,var(--muted),var(--muted)_6px,var(--hover)_6px,var(--hover)_12px)]',
  shareQrImage: 'gg-as-share-act-se-qr bg-[var(--color-white)] object-contain',
  shareLink:
    'gg-as-share-act-se-link flex items-center gap-2 rounded-[var(--radius-xl)] border border-[var(--border-strong)] text-[length:var(--font-body)] text-[var(--muted-fg)] !px-[11px] !py-[9px] [&_span]:min-w-0 [&_span]:flex-1 [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap',
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

export function agentSettingsPaneClass(active: boolean) {
  return active ? asClass.paneVisible : asClass.paneHidden
}

export function profileInputClass(mode: 'default' | 'readonly' | 'textarea' = 'default') {
  if (mode === 'readonly') return cx(profileInputBase, profileInputReadonly)
  if (mode === 'textarea') return cx(profileInputBase, profileInputDefault, profileInputTextarea)
  return cx(profileInputBase, profileInputDefault)
}

export function shareSegmentButtonClass(active: boolean) {
  return cx(shareSegmentButtonBase, active ? shareSegmentButtonActive : shareSegmentButtonInactive)
}

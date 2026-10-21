const other = 1

function Counterexamples(event: { currentTarget: HTMLElement }) {
  const currentTarget = event.currentTarget
  event.currentTarget.style.opacity = '0.8'
  ;(event.currentTarget as HTMLElement).style.background = 'red'
  currentTarget.style.color = 'blue'
  event.currentTarget.style.borderColor = 'black'

  const styleSingle = { transition: 'opacity 150ms ease' }
  const styleDouble = { transition: "color .12s ease" }
  const styleTemplate = { transition: `transform 0.25s ease` }
  const styleExtra = { transition: 'width 300ms ease' }
  const safeStyle = { transition: 'opacity var(--dur-fast) ease' }

  const classes = 'duration-[150ms] duration-[.18s] duration-[var(--dur-fast)]'
  // animate-[...] 里的字面时长/缓动:前两条该红,后两条不该 ——
  // 一条用 token,一条是无限循环的环境动画(节律不是转场)。
  const animated = 'animate-[slide_300ms_cubic-bezier(0.22,1,0.36,1)] animate-[pop_.2s_ease]'
  // 时长是 `]` 前最后一个 token —— 前瞻少写一个 `]` 就会整条漏掉,所以这一条必须在。
  const animatedTail = 'animate-[pop_200ms]'
  const animatedSafe = 'animate-[slide_var(--dur-slow)_var(--ease)] animate-[spin_0.9s_linear_infinite]'
  const templated = `duration-[0.25s] ${other}`
  const extraClass = 'duration-[1.2s]'
  return { styleSingle, styleDouble, styleTemplate, styleExtra, safeStyle, classes, templated, extraClass, animated, animatedTail, animatedSafe }
}

// event.currentTarget.style.border = '1px solid red'
// transition: 'opacity 1s ease'
// duration-[123ms]

export default Counterexamples

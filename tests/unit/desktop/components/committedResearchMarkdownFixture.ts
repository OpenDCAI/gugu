const PREFIX_INLINE_MATH = [
  '$\\rho_W$',
  '$p$',
  '$0 \\le p \\le 1$',
  '$\\operatorname{tr}(\\rho_W)=1$',
  '$T=-pI_3$',
  '$T^{\\mathsf T}T=p^2I_3$',
  '$S_{\\max}=2\\sqrt{2}p$',
  '$p>1/\\sqrt{2}$',
  '$p\\le 1/3$',
  '$p>1/3$',
]

const SUFFIX_INLINE_MATH = [
  '$\\lambda_1=p^2$',
  '$\\lambda_2=p^2$',
  '$\\langle B\\rangle=2\\sqrt{2}p$',
  '$p=1$',
]

export const COMMITTED_RESEARCH_PREFIX = [
  '@研究主持人 对 Werner 态做终态核验。',
  `已得到 ${PREFIX_INLINE_MATH.join('，')}。`,
  '纠缠与 CHSH 阈值之间仍有区间 $1/3',
].join('\n\n')

export const COMMITTED_RESEARCH_FULL = [
  `${COMMITTED_RESEARCH_PREFIX}$；COMMITTED_SUFFIX_PRESENT。`,
  `谱与观测量复核为 ${SUFFIX_INLINE_MATH.join('，')}。`,
  '$$\\rho_W=p\\lvert\\psi^-\\rangle\\langle\\psi^-\\rvert+(1-p)I/4$$',
  '$$\\operatorname{spec}(\\rho_W)=\\left\\{\\frac{1+3p}{4},\\frac{1-p}{4},\\frac{1-p}{4},\\frac{1-p}{4}\\right\\}$$',
  '| 检查 | 结论 |\n| --- | --- |\n| trace | 通过 |',
  '行内代码保留 `$literal$`，不计入数学投影。',
  '```text\n$fenced-literal$\n```',
  '```mermaid\ngraph TD\n  A[raw row] --> B[committed DOM]\n```',
  `${'长消息稳定段落。'.repeat(120)}LONG_MESSAGE_END`,
].join('\n\n')

export const COMMITTED_RESEARCH_MATH_COUNT = 17

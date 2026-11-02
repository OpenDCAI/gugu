import type { ComponentProps } from 'react'
import { CodeBlock, defaultComponents, useIsCodeFenceIncomplete } from 'streamdown'
import { PlatformCopyButton } from './PlatformCopyButton'

const DefaultCode = defaultComponents.code

/** Use Streamdown's code container/highlighter and action placement with the host's clipboard transport. */
export function PlatformCodeBlock({ children, node, className, ...props }: ComponentProps<typeof DefaultCode>) {
  const incomplete = useIsCodeFenceIncomplete()
  const language = /language-([^\s]+)/.exec(className ?? '')?.[1] ?? ''
  // Inline spans and the custom renderers (Mermaid, SVG figures) retain Streamdown's original pipeline.
  if (!('data-block' in props) || language === 'mermaid' || language === 'svg') {
    return <DefaultCode {...props} node={node} className={className}>{children}</DefaultCode>
  }
  const { 'data-block': _block, ...rest } = props
  const code = typeof children === 'string' ? children : ''
  return <CodeBlock {...rest} code={code} language={language} className={className} isIncomplete={incomplete} lineNumbers={false}>
    <PlatformCopyButton key={code} text={code} kind="code" />
  </CodeBlock>
}

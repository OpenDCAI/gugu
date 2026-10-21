import type { ExtensionConsentDetails } from '../../session/shared/extensions/host-actions'

/**
 * A consent's body, wherever it is asked — the shell's sheet and the session page's own dialog: its lines, then the
 * install's「详情」(owner 10-06「node launch.mjs 没人看得懂」). The plain sentence says what it will do; the exact
 * command lines are one fold away, for whoever wants them.
 */
/**
 * What an install is allowed, one item per line of `text` (describePermissions): a line that wraps on a phone must not read
 * as the start of the next one, so each is its own list item. A blank line ends a block (the consent's「来自 X」 line above
 * the permissions); a block of one line is a sentence, not a list.
 */
export function ConsentLines({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`flex flex-col gap-3 ${className ?? ''}`}>
      {text.split(/\n{2,}/).map((block, index) => {
        const lines = block.split('\n').filter((line) => line.trim() !== '')
        return lines.length > 1 ? (
          <ul key={index} className="flex list-disc flex-col gap-1 !pl-5">
            {lines.map((line, at) => <li key={at}>{line}</li>)}
          </ul>
        ) : (
          <p key={index}>{lines[0]}</p>
        )
      })}
    </div>
  )
}

export function ConsentBody({ description, details }: { description: string; details?: ExtensionConsentDetails }) {
  return (
    <>
      <ConsentLines text={description} />
      {details ? (
        <details className="!mt-2 text-[length:var(--font-caption)]" data-testid="extension-consent-details">
          <summary className="cursor-pointer select-none">{details.label}</summary>
          <div className="!mt-1">{details.caption}</div>
          <pre className="!mt-1 whitespace-pre-wrap break-all font-mono">{details.lines.join('\n')}</pre>
        </details>
      ) : null}
    </>
  )
}

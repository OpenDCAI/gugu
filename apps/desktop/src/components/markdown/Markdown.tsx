import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Streamdown, type CustomRendererProps, type PluginConfig } from 'streamdown'
import 'katex/dist/katex.min.css'
import '@gugu/session-shared/markdown.css'
import {
  markdownRehypePlugins,
  markdownRemarkPlugins,
  normalizeMarkdownSource,
  type MarkdownDialectOptions,
  type MarkdownTrust,
} from '@gugu/session-shared/markdown/dialect'
import { readEffectiveHostTheme, subscribeToHostTheme } from '@renderer/lib/theme/host-theme'
import { MermaidDiagram } from '@renderer/lib/ui/mermaid-diagram'
import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink'
import { displayAgentReferences, isMentionMarkerUrl } from '../../lib/mentionMdast'
import { markdownCodeHighlighter } from './codeHighlight'
import { FILE_PILL_CLASS, hookFilePillCopy, rehypeGroupFilePills } from './filePills'
import { GroupFileName } from './GroupFileName'
import { revealMarkdownAnchor } from './revealAnchor'
import { followLink } from '../../lib/guguLinks'

export type MarkdownDensity = 'compact' | 'comfortable'

export interface MarkdownProps {
  content: string
  /** Whose words these are — decides raw HTML, images and code/table controls (see the dialect). */
  trust: MarkdownTrust
  density?: MarkdownDensity
  hardBreaks?: boolean
  frontmatter?: boolean
  /** Chat: the per-render nonce that `useMentionRender` injected for @mentions backed by to_user_ids. */
  mentionMarker?: string
  /** Drawn on an accent-coloured surface (your own bubble): links take the text colour. */
  onAccent?: boolean
  /** Return true when the click was handled here; otherwise the link opens in the system browser. */
  onOpenLink?: (href: string) => boolean
  /** `document` trust: draws an image (a workspace-relative source must be resolved by the host). */
  renderImage?: (image: { src?: string; alt: string }) => ReactNode
  className?: string
}

const DensityContext = createContext<MarkdownDensity>('compact')
const EXTERNAL_LINK = /^(https?:|mailto:|tel:)/i

/** A link's words when they are plain text (no emphasis, code or image inside); null otherwise. */
function onlyText(children: ReactNode): string | null {
  if (typeof children === 'string') return children
  return Array.isArray(children) && children.length === 1 && typeof children[0] === 'string' ? children[0] : null
}

function MermaidRenderer({ code, isIncomplete }: CustomRendererProps) {
  const density = useContext(DensityContext)
  const theme = useSyncExternalStore(subscribeToHostTheme, readEffectiveHostTheme, () => 'light' as const)
  if (isIncomplete) {
    return (
      <pre>
        <code>{code}</code>
      </pre>
    )
  }
  return <MermaidDiagram chart={code} isDark={theme === 'dark'} compact={density === 'compact'} />
}

const PLUGINS: PluginConfig = {
  code: markdownCodeHighlighter,
  renderers: [{ language: 'mermaid', component: MermaidRenderer }],
}

// Plugin arrays keep their identity per dialect option set, so a re-render never re-creates the processor.
const pluginCache = new Map<string, { remark: ReturnType<typeof markdownRemarkPlugins>; rehype: ReturnType<typeof markdownRehypePlugins> }>()
function pluginsFor(options: MarkdownDialectOptions) {
  const key = `${options.trust}|${options.hardBreaks ? 1 : 0}|${options.frontmatter ? 1 : 0}`
  let entry = pluginCache.get(key)
  if (!entry) {
    entry = { remark: markdownRemarkPlugins(options), rehype: markdownRehypePlugins(options, [rehypeGroupFilePills]) }
    pluginCache.set(key, entry)
  }
  return entry
}

/**
 * The one markdown renderer of the React surfaces (chat, previews, documents, PR comments, extension notes).
 * Grammar, sanitizing and typography come from `@gugu/session-shared` — the transcript renders the same dialect.
 */
export const Markdown = memo(function Markdown({
  content,
  trust,
  density = 'compact',
  hardBreaks = false,
  frontmatter = false,
  mentionMarker,
  onAccent = false,
  onOpenLink,
  renderImage,
  className,
}: MarkdownProps) {
  // Streamdown's memo ignores `components` and plugin arrays: callbacks are read through refs, and anything
  // that changes the element mapping is part of the key below.
  const openLinkRef = useRef(onOpenLink)
  openLinkRef.current = onOpenLink
  const renderImageRef = useRef(renderImage)
  renderImageRef.current = renderImage
  const hasImageRenderer = !!renderImage
  // A pill's hover says which version it was picked on, in the person's language (read through a ref, as the callbacks are).
  const { t } = useTranslation('messaging')
  const tRef = useRef(t)
  tRef.current = t
  useEffect(() => hookFilePillCopy(), [])

  const plugins = pluginsFor({ trust, hardBreaks, frontmatter })
  const source = useMemo(() => normalizeMarkdownSource(displayAgentReferences(content)), [content])
  const components = useMemo(
    () => ({
      a: ({ href, children, node: _node, ...rest }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) => {
        // Only this render's nonce is a mention; any other `#ggm-*` (forged, stale) renders as plain text.
        if (mentionMarker && href === mentionMarker) return <span data-mention="true">{children}</span>
        if (isMentionMarkerUrl(href)) return <>{children}</>
        // Footnote references and heading anchors scroll inside this document; they never navigate the app.
        if (href?.startsWith('#')) {
          return (
            <a
              {...rest}
              href={href}
              onClick={(event) => {
                event.preventDefault()
                revealMarkdownAnchor(event.currentTarget.closest('.gg-md'), href.slice(1))
              }}
            >
              {children}
            </a>
          )
        }
        const onClick = (event: { preventDefault(): void }) => {
          // A link the host did not claim goes to the system browser only if it is a web, mail or phone link.
          if ((href && (followLink(href) || openLinkRef.current?.(href))) || !EXTERNAL_LINK.test(href ?? '')) event.preventDefault()
        }
        // App 引用 pill: `@` + a group file's link (rehypeGroupFilePills) is the transcript's file pill; its click is the
        // link's, so it opens where that link opens — at the place it points at.
        const groupFile = href ? parseGroupFileLink(href) : null
        if (groupFile && typeof rest.className === 'string' && rest.className.split(/\s+/).includes(FILE_PILL_CLASS)) {
          const label = onlyText(children) ?? ''
          const picked = groupFile.version === undefined ? null : tRef.current('filePill.picked', { version: groupFile.version })
          return (
            <a {...rest} className={`gg-md-mention ${FILE_PILL_CLASS}`} data-mention-kind="file" href={href} title={picked ? `${label} · ${picked}` : label} onClick={onClick}>
              <span className="gg-md-mention-icon" aria-hidden="true">
                <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6L9 2z" />
                  <polyline points="9 2 9 6 13 6" />
                </svg>
              </span>
              <span className="gg-file-pill-label">{children}</span>
            </a>
          )
        }
        // A group file's link written as its name reads as the file list reads it (摩擦单 F39).
        const fileName = groupFile ? onlyText(children) : null
        return (
          <a
            {...rest}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClick}
          >
            {fileName !== null ? <GroupFileName name={fileName} /> : children}
          </a>
        )
      },
      ...(hasImageRenderer
        ? {
            img: ({ src, alt }: { src?: string; alt?: string }) =>
              renderImageRef.current?.({ src: typeof src === 'string' ? src : undefined, alt: alt ?? '' }),
          }
        : {}),
    }),
    [mentionMarker, hasImageRenderer]
  )

  if (!content) return null
  return (
    <DensityContext.Provider value={density}>
      <Streamdown
        key={`${trust}|${hardBreaks}|${frontmatter}|${mentionMarker ?? ''}|${hasImageRenderer}`}
        mode="static"
        parseIncompleteMarkdown={false}
        lineNumbers={false}
        controls={trust === 'document' ? { code: { download: false } } : false}
        linkSafety={{ enabled: false }}
        remarkPlugins={plugins.remark}
        rehypePlugins={plugins.rehype}
        plugins={PLUGINS}
        components={components}
        className={['gg-md', `gg-md--${density}`, onAccent && 'gg-md--on-accent', className].filter(Boolean).join(' ')}
      >
        {source}
      </Streamdown>
    </DensityContext.Provider>
  )
}, sameMarkdownProps)

// onOpenLink / renderImage are read through refs above, so a new identity is no reason to render and parse again:
// callers pass inline arrows (a message bubble does on every render). Whether one is given still counts, since that
// changes the element mapping.
function sameMarkdownProps(prev: MarkdownProps, next: MarkdownProps): boolean {
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof MarkdownProps>) {
    if (key === 'onOpenLink' || key === 'renderImage' ? !prev[key] !== !next[key] : prev[key] !== next[key]) return false
  }
  return true
}

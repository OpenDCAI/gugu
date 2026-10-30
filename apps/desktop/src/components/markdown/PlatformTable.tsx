import { useContext, useRef, useState, type ComponentProps } from 'react'
import { defaultComponents, defaultTranslations, extractTableDataFromElement, StreamdownContext, TableDownloadDropdown, tableDataToTSV } from 'streamdown'
import { Expand } from '@/lib/icons'
import { IconButton } from '@/components/ui/IconButton'
import { Sheet } from '@/components/ui/Sheet'
import { PlatformCopyButton } from './PlatformCopyButton'

const DefaultTable = defaultComponents.table

type TableProps = ComponentProps<typeof DefaultTable>

function PhoneTable({ onExpand, ...props }: TableProps & { onExpand?: () => void }) {
  const container = useRef<HTMLDivElement>(null)
  const context = useContext(StreamdownContext)
  const readTSV = () => {
    const table = container.current?.querySelector('table')
    if (!table) throw new Error('Table not found')
    return tableDataToTSV(extractTableDataFromElement(table))
  }
  return <div ref={container} data-streamdown="table-wrapper" className="my-4 flex flex-col gap-2 [&>[data-streamdown=table-wrapper]]:m-0">
    <div className="flex items-center justify-end gap-1">
      <PlatformCopyButton text={readTSV} kind="table" />
      <TableDownloadDropdown />
      {onExpand && <IconButton size="sm" title={defaultTranslations.viewFullscreen} aria-label={defaultTranslations.viewFullscreen} onClick={onExpand}><Expand size={14} /></IconButton>}
    </div>
    {/* Retain Streamdown's table layout, scrolling and cell components; replace only phone controls. */}
    <StreamdownContext.Provider value={{ ...context, controls: { ...(typeof context.controls === 'object' ? context.controls : {}), table: false } }}>
      <DefaultTable {...props} />
    </StreamdownContext.Provider>
  </div>
}

/** Phones offer TSV through their platform. Desktop rich text stays in the untouched default table. */
export function PlatformTable(props: TableProps) {
  const [expanded, setExpanded] = useState(false)
  return <>
    <PhoneTable {...props} onExpand={() => setExpanded(true)} />
    {expanded && <Sheet fullScreenMobile ariaLabel={defaultTranslations.viewFullscreen} onClose={() => setExpanded(false)}>
      <div className="gg-md p-4 pt-12"><PhoneTable {...props} /></div>
    </Sheet>}
  </>
}

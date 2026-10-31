import { useEffect } from 'react'
import { useShellTabIs } from '../../lib/shellTab'

// The phone shell keeps the contacts page in its pager while another tab is shown: leaving resets it to the root
// (#6730). A leaf of its own, so being shown or hidden re-renders this and nothing else (@@@shell-tab-store).
export function OnContactsHidden({ run }: { run: () => void }) {
  const shown = useShellTabIs('contacts')
  useEffect(() => { if (!shown) run() }, [shown, run])
  return null
}

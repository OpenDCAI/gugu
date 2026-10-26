import { readdirSync } from 'node:fs'
import { expect,it } from 'vitest'
import { integrationIcons } from '@gugu/session-plugins/integration-icons'
it('has a built-in icon for every integration implementation',()=>{
 const names=readdirSync(new URL('../../packages/session-plugins/src/integrations/impl/',import.meta.url),{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort()
 expect(Object.keys(integrationIcons).sort()).toEqual(names)
 for(const name of names)expect(integrationIcons[name]!.variants.length).toBeGreaterThan(0)
})

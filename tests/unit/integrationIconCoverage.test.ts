import { readdirSync } from 'node:fs'
import { expect,it } from 'vitest'
import { integrationIcons } from '@gugu/session-plugins/integration-icons'
import { builtinIntegrationSummaries } from '@gugu/session-plugins/integration-summaries'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
it('has a built-in icon for every integration implementation',()=>{
 const names=readdirSync(new URL('../../packages/session-plugins/src/integrations/impl/',import.meta.url),{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort()
 expect(Object.keys(integrationIcons).sort()).toEqual(names)
 for(const name of names)expect(integrationIcons[name]!.variants.length).toBeGreaterThan(0)
})

it('has nonempty Chinese and English list copy for every implementation',()=>{
 const names=readdirSync(new URL('../../packages/session-plugins/src/integrations/impl/',import.meta.url),{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort()
 expect(Object.keys(builtinIntegrationSummaries).sort()).toEqual(names)
 for(const id of names)for(const locale of ['en','zh-CN'] as const){
  expect(builtinIntegrationSummaries[id]!.name[locale].trim()).not.toBe('')
  expect(builtinIntegrationSummaries[id]!.name[locale]).not.toBe(id)
  expect(builtinIntegrationSummaries[id]!.description[locale].trim()).not.toBe('')
 }
})

it('bundles the list copy in a browser without provider behaviors or SDKs',async()=>{
 const output=await build({entryPoints:[fileURLToPath(new URL('../../packages/session-plugins/src/integrations/summaries.ts',import.meta.url))],bundle:true,platform:'browser',write:false,metafile:true})
 expect(Object.keys(output.metafile!.inputs).every(path=>path.endsWith('/summary.ts')||path.endsWith('/summaries.ts'))).toBe(true)
})

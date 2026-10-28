// @vitest-environment jsdom
import { act } from 'react'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { QueryClient,QueryClientProvider } from '@tanstack/react-query'
import { createReactHarness } from '../../../support/testHarness'
import { useIntegrationAccounts } from '../../../../apps/desktop/src/session/renderer/features/integrations/use-integration-accounts'
const fixture=vi.hoisted(()=>({ accounts:vi.fn(),checks:vi.fn() }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/library/library-host',()=>({isTooOld:()=>false,useLibraryHost:()=>({key:'cloud',assistantPanel:{},assistantPanelExpected:true,integrations:{accounts:fixture.accounts,checkAccounts:fixture.checks}})}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider',()=>({ISSUE_CONNECTION_STATUS_QUERY_KEY:['status']}))
let h:ReturnType<typeof createReactHarness>,client:QueryClient
beforeEach(()=>{vi.useFakeTimers();h=createReactHarness();client=new QueryClient({defaultOptions:{queries:{gcTime:0}}});fixture.accounts.mockReset();fixture.checks.mockReset()})
afterEach(()=>{h.cleanup();client.clear();vi.useRealTimers()})
it.each(['accounts','checks'] as const)('never retries a fixed snapshot failure in %s',async which=>{
  fixture.accounts.mockResolvedValue([{accountId:'a'}]);fixture.checks.mockResolvedValue([])
  fixture[which].mockRejectedValue(Object.assign(new Error('snapshot'),{code:'collection-unavailable'}))
  function Probe(){useIntegrationAccounts('mail',true);return null}
  await h.render(<QueryClientProvider client={client}><Probe/></QueryClientProvider>)
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000)})
  expect(fixture[which]).toHaveBeenCalledTimes(1)
})

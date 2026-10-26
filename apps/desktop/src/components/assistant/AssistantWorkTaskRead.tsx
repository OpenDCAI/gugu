import type {ReactNode} from 'react'
import {LoadingIndicator} from '../../lib/loading/LoadingIndicator'
import {AssistantEmpty} from '../../session/renderer/features/assistant/assistant-ui-parts'
import {useReadFailure} from '../../session/renderer/features/assistant/assistant-read-failure'
import type {AssistantPanelTask,AssistantWorkTasksRead} from './assistant-panel-tasks'

/** A failed refresh keeps the last account copy visible and retries automatically. */
export function AssistantWorkTaskRead({read,failedTitle,children}:{
  read:AssistantWorkTasksRead&{reload:()=>void}
  failedTitle:string
  children:(data:AssistantPanelTask[])=>ReactNode
}) {
  const failure=useReadFailure(read.state==='error'?read.error:null,null,'',read.reload)
  if(read.state==='loading')return <AssistantEmpty><LoadingIndicator size="inline"/></AssistantEmpty>
  return <>
    {failure ? <AssistantEmpty title={read.data.length?undefined:failedTitle}><span role="alert">{failure.text}</span></AssistantEmpty> : null}
    {!failure||read.data.length ? children(read.data) : null}
  </>
}

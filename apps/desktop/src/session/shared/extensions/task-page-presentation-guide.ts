export const TASK_PAGE_PRESENTATION_GUIDE = `# A task page's native placement (API 30)

Needs \`agents:tools\`
- On the program's own opaque page lease, \`await lease.presentation()\` returns
  \`{space:'screen-dip',bounds:{x,y,width,height},clip:{x,y,width,height},zoomFactor,relativeTo:{windowId}}\`, or null.
  All geometry comes from the actual native page view and its host. Page CSS points map to screen DIP as
  \`bounds.x + x * zoomFactor\` and \`bounds.y + y * zoomFactor\`; hide decoration outside clip.
  This is not an all-window query: no native page/window ID, task ID or arbitrary target is accepted.
- \`lease.onPresentation(fn)\` returns unsubscribe and reports subsequent placement/visibility/zoom changes.
  Read presentation() once for the initial value; null clears decoration when no native view is visible or available.
  Unmounting an App viewport may restore the original visible tab; measurements then follow that native tab.
  Closing or stopping the task clears it; late events cannot revive the lease. Resource events carry no tool-call authority.
  The owning program may read after a tool call finishes; another App/program/task cannot read this resource.
  Geometry and display are informational, never permission to authorize, block or delay an action.
`;

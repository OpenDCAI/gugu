export const TASK_PAGE_FILES_GUIDE = `# File cards for a task page (API 30)

Needs \`agents:tools\`
- In a live agent tool call, \`await lease.filePayloads([{file,expectedVersion?}])\` returns
  \`[{name,mimeType,bytes:ArrayBuffer,version}]\`. The lease must belong to this App/program/task.
  Declare the tool's file parameter (or its array items) with \`format:'gugu-file'\`. F16 checks those cards as the
  calling agent and hands them to that exact call. Another call, background work, a person's page, a handed chat
  or a broad file capability cannot substitute. Do not choose a task, actor or local path in these arguments.
- Accept only a file UUID or its gugu-file link; an explicit card version is preserved even after F16 turns the link
  into an ID. An expectedVersion must agree with the handed card. If several versions were handed, choose one explicitly.
  A changed version, unavailable size, lost file access or interrupted call returns no payload batch.
  At most eight distinct files and 25 MiB combined, with verified sizes before content is read. No paths, signed URLs,
  tokens or filesystem access are returned. The file service retains its existing agent membership and version checks.
- Adapt these in-memory bytes to your page driver's file payloads. For Playwright, convert bytes with Buffer.from(bytes)
  and pass {name,mimeType,buffer} to setInputFiles. Do not pass a string path. The ordinary task page protocol continues
  to reject DOM.setFileInputFiles, including from connection maintenance.
- This deliberately narrows the old host Browser upload behavior: local files must be shared as file cards first.
  Say that in your tool description. The host supplies authorized bytes; page/file-input selection remains App code.
`;

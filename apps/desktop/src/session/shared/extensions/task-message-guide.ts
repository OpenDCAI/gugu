export const TASK_MESSAGE_GUIDE = `# A person's conversation shortcuts in a task page

Needs \`agents:tools\`
- \`taskMessage({intent:"pause"|"continue"})\` sends a host-owned ordinary message to the task bound to this page.
  Call \`gugu.taskMessage({intent:"pause"})\` from the person's click; the isolated host reads actual activation, not an App-supplied gesture.
  Only those two intents are accepted. The host supplies localized "Please pause." / "Please continue."; no text, task/agent ID or target is accepted.
  Programs, background pages, unbound pages and agent-operated check pages cannot send it. No agents:control grant is added.
  Completion means message admission, not that the Agent has paused or continued. Unknown delivery remains an error; do not retry it automatically.
  The desktop exposes this page member; feature-detect it on other hosts. It uses the normal conversation path, never Stop or a target picker.
`;

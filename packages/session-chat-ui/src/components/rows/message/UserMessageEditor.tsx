/** @jsxImportSource solid-js */
import { onMount } from 'solid-js';
import type { ChatCommands } from '@session-chat/commands';
import { useChatTranslator } from '@session-chat/localization';
import { messageEditor, messageEditorActions, messageEditorButton, messageEditorSend, messageEditorText } from './message-editor.css';

export function UserMessageEditor(props: {
  edit: NonNullable<ChatCommands['editingMessage']>;
  height: number;
  textHeight: number;
}) {
  const translate = useChatTranslator();
  let textarea!: HTMLTextAreaElement;
  onMount(() => { textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); });
  return <div data-user-message-editor={props.edit.itemId} class={messageEditor}
    style={{ height: `${props.height}px` }} onClick={(event) => event.stopPropagation()}>
    <textarea ref={textarea} class={messageEditorText} aria-label={translate('transcript.editMessage')}
      style={{ height: `${props.textHeight}px` }} value={props.edit.text} disabled={props.edit.pending}
      onInput={(event) => props.edit.onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.isComposing) return;
        if (event.key === 'Escape' && !props.edit.pending) { event.preventDefault(); props.edit.onCancel(); }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && props.edit.canSubmit) {
          event.preventDefault(); props.edit.onSubmit();
        }
      }} />
    <div class={messageEditorActions}>
      <button type="button" class={messageEditorButton} disabled={props.edit.pending}
        onClick={() => props.edit.onCancel()}>{translate('transcript.cancelEdit')}</button>
      <button type="button" class={`${messageEditorButton} ${messageEditorSend}`} disabled={!props.edit.canSubmit}
        onClick={() => props.edit.onSubmit()}>{translate('transcript.sendEdit')}</button>
    </div>
  </div>;
}

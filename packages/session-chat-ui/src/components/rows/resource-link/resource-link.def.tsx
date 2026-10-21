/** @jsxImportSource solid-js */
import { ROW_H } from '@session-chat/components/engine/row-metrics';
import { defineUnit } from '@session-chat/core/units';
import { pxTokens } from '@session-chat/styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import type { ChatResourceLink } from '@session-chat/model';
import { ResourceLink } from './ResourceLink';
import { resourceLinkRoot, resourceLinkVars } from './resource-link.css';

export const resourceLinkUnitDef = defineUnit<ChatResourceLink, { rowH: number }>({
  kind: 'resource-link',
  margin: { top: 2, bottom: 2 },
  vars: { rowH: ROW_H },

  measure(_data, _ctx, vars): number {
    return vars.rowH;
  },

  Render(props) {
    return (
      <div
        class={resourceLinkRoot}
        style={assignInlineVars(resourceLinkVars, pxTokens({ rowH: props.vars.rowH }))}
      >
        <ResourceLink item={props.data} />
      </div>
    );
  },
});

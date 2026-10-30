/** @jsxImportSource solid-js */
import { ROW_H } from '@session-chat/components/engine/row-metrics';
import { defineUnit } from '@session-chat/core/units';
import { pxTokens } from '@session-chat/styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import type { ChatResourceLink } from '@session-chat/model';
import { ResourceLink, resourceLinkLayout } from './ResourceLink';
import { resourceLinkRoot, resourceLinkVars } from './resource-link.css';

export const resourceLinkUnitDef = defineUnit<ChatResourceLink, { rowH: number }>({
  kind: 'resource-link',
  margin: { top: 2, bottom: 2 },
  vars: { rowH: ROW_H },

  measure(data, ctx): number { return resourceLinkLayout(data, ctx).height; },

  Render(props) {
    return (
      <div
        class={resourceLinkRoot}
        style={assignInlineVars(resourceLinkVars, pxTokens({ rowH: resourceLinkLayout(props.data, props.ctx.measureCtx!()).height }))}
      >
        <ResourceLink item={props.data} measureCtx={props.ctx.measureCtx!} />
      </div>
    );
  },
});

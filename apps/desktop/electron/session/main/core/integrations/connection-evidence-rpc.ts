import type {DeviceRpcHandlers} from '@gugu/core/cloud/deviceRpcResponder';
import {ownerConnectionControl} from './owner-connection-control';
/** The normal private device channel already verifies the account envelope.
 * The control additionally checks current owner, original target and server DTO. */
export const connectionEvidenceRpcHandlers:DeviceRpcHandlers={
 'connections.evidence.read':async(input,ctx)=>({result:await ownerConnectionControl().readEvidence(input,ctx.request.user_id)}),
 'connections.evidence.fence':async(input,ctx)=>({result:await ownerConnectionControl().fenceEvidence(input,ctx.request.user_id)}),
};

import type {ProviderAccountRow} from '@main/db/schema';
import type {NativeConnectionAttempt} from '@gugu/core/cloud/connectionAttempts';

/** Frozen public request bytes are created beside the real credential commit,
 * rather than reconstructed later from a possibly changed account snapshot. */
export function connectionPublicationRequest(attempt:NativeConnectionAttempt,account:ProviderAccountRow):string {
  if(attempt.effectKind!=='authorize'||!attempt.recreationId)throw Error('CONNECTION_AUTHORIZATION_INVALID');
  const displayName=account.meta?.displayName??account.meta?.login;
  const data={providerId:account.providerId,accountId:account.accountId,isDefault:account.isDefault,configured:true,...(displayName?{displayName}:{})};
  const document=JSON.stringify({version:1,providerId:account.providerId,accountId:account.accountId,isDefault:account.isDefault,
    connectedAt:account.createdAt,updatedAt:account.updatedAt,host:account.meta?.host,login:account.meta?.login,
    avatarUrl:account.meta?.avatarUrl,credentialSource:account.meta?.credentialSource,displayName:account.meta?.displayName});
  return JSON.stringify({operationId:attempt.operationId,scopeKey:attempt.scopeKey,resourceKey:attempt.resourceKey,
    expectedRevision:attempt.expectedItemRevision,operation:'save',data,document,deviceId:attempt.deviceId,recreationId:attempt.recreationId});
}

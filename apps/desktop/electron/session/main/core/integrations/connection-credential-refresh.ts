import {accessTokenExpiresSoon,mcpOAuthCredentialsSchema,toIntegrationCredentials} from '@gugu/session-plugins/integrations';
import type {IntegrationAccountRecord,IntegrationCredentialStore} from './integration-credential-store';
import {refreshMcpCredentials} from './mcp-oauth-flow';

type Store=Pick<IntegrationCredentialStore,'getAccount'|'compareAndSwapAccount'>;
export async function refreshIntegrationAccount(input:{store:Store;pending:Map<string,Promise<IntegrationAccountRecord|null>>;
  refresh?:typeof refreshMcpCredentials},integrationId:string,accountId:string|undefined,enabled:boolean):Promise<IntegrationAccountRecord|null> {
  const account=await input.store.getAccount(integrationId,accountId);
  if(!account||!enabled)return account;
  const parsed=mcpOAuthCredentialsSchema.safeParse(account.credentials);
  if(!parsed.success||!accessTokenExpiresSoon(parsed.data))return account;
  const key=`${integrationId}:${account.accountId}`;
  const inFlight=input.pending.get(key);
  if(inFlight)return inFlight;
  const refresh=(async()=>{
    const refreshed=await(input.refresh??refreshMcpCredentials)(parsed.data);
    const next={...account,credentials:toIntegrationCredentials(refreshed)};
    // Never hand the old caller credentials read after a concurrent disconnect,
    // edit or authorization. The next request may read the current connection.
    if(!await input.store.compareAndSwapAccount(integrationId,account,next.credentials))return null;
    return next;
  })().finally(()=>input.pending.delete(key));
  input.pending.set(key,refresh);
  return refresh;
}

import {describe,expect,it,vi} from 'vitest';
import {refreshIntegrationAccount} from './connection-credential-refresh';
import type {IntegrationAccountRecord} from './integration-credential-store';

const credentials=()=>({serverUrl:'https://fixture.invalid/mcp',redirectUrl:'http://127.0.0.1/callback',
 clientInformation:{client_id:'fixture'},tokens:{access_token:'fixture-old',refresh_token:'fixture-refresh',token_type:'bearer',expires_in:1},obtainedAt:0});
function fixture(){
 let current:IntegrationAccountRecord|null={accountId:'account',credentials:credentials()};
 let finish!:(value:ReturnType<typeof credentials>)=>void;
 const pending=new Map<string,Promise<IntegrationAccountRecord|null>>();
 const refresh=vi.fn(()=>new Promise<ReturnType<typeof credentials>>(resolve=>{finish=resolve;}));
 const compareAndSwapAccount=vi.fn(async(_provider:string,prior:IntegrationAccountRecord,next:IntegrationAccountRecord['credentials'])=>{
  if(!current||JSON.stringify(current.credentials)!==JSON.stringify(prior.credentials))return false;
  current={...current,credentials:next};return true;
 });
 const input={pending,refresh,store:{getAccount:vi.fn(async()=>current),compareAndSwapAccount}};
 return {input,get current(){return current;},set current(value){current=value;},finish(){finish({...credentials(),tokens:{...credentials().tokens,access_token:'fixture-fresh'},obtainedAt:Date.now()});}};
}
describe('conditional credential refresh delivery',()=>{
 it('deduplicates concurrent refreshes and returns only the credentials committed by that refresh',async()=>{
  const f=fixture();const first=refreshIntegrationAccount(f.input,'github',undefined,true);
  const second=refreshIntegrationAccount(f.input,'github',undefined,true);
  await Promise.resolve();await Promise.resolve();f.finish();
  expect(await first).toEqual(await second);expect(f.input.refresh).toHaveBeenCalledTimes(1);
  expect(f.current?.credentials.tokens).toMatchObject({access_token:'fixture-fresh'});expect(f.input.pending.size).toBe(0);
 });
 it.each(['reauthorize','disconnect'] as const)('does not return replacement or stale credentials after %s',async(mode)=>{
  const f=fixture();const request=refreshIntegrationAccount(f.input,'github',undefined,true);
  await Promise.resolve();await Promise.resolve();
  f.current=mode==='reauthorize'?{accountId:'account',credentials:{token:'fixture-new-authorization'}}:null;
  const changed=f.current;f.finish();expect(await request).toBeNull();expect(f.current).toEqual(changed);
  expect(f.input.pending.size).toBe(0);
 });
 it('leaves non OAuth credentials and disabled refreshes on the existing read path',async()=>{
  const f=fixture();f.current={accountId:'account',credentials:{token:'fixture-static'}};
  expect(await refreshIntegrationAccount(f.input,'github',undefined,true)).toEqual(f.current);
  expect(await refreshIntegrationAccount(f.input,'github',undefined,false)).toEqual(f.current);
  expect(f.input.refresh).not.toHaveBeenCalled();expect(f.input.store.compareAndSwapAccount).not.toHaveBeenCalled();
 });
});

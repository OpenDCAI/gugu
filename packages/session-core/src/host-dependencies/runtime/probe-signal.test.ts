import {describe,expect,it} from 'vitest';
import type {IExecutionContext} from '../../exec/execution-context';
import {execInProcessGroup} from '../../exec/process-group';
import {defaultProbeStatus,runVersionProbe} from './probe';

const nativeContext={
  supportsLocalSpawn:true,
  exec:(command:string,args:string[],options:Parameters<IExecutionContext['exec']>[2])=>execInProcessGroup(command,args,options ?? {}),
} as unknown as IExecutionContext;

describe('signal-terminated CLI version probes',()=>{
  it.skipIf(process.platform==='win32')('rejects a real child terminated by SIGKILL instead of treating a null exit code as success',async()=>{
    await expect(execInProcessGroup(process.execPath,['-e',"process.kill(process.pid,'SIGKILL')"],{timeout:5000}))
      .rejects.toMatchObject({code:null,signal:'SIGKILL'});
  });

  it.skipIf(process.platform==='win32')('keeps a real signal failure unusable even after partial version output',async()=>{
    const result=await runVersionProbe('opencode',process.execPath,['-e',"process.stdout.write('1.18.25\\n',()=>process.kill(process.pid,'SIGKILL'))"],nativeContext);
    expect(result).toMatchObject({exitCode:null,signal:'SIGKILL',timedOut:false});
    expect(defaultProbeStatus(result)).toBe('error');
  });

  it('preserves a transport signal without inventing a signing diagnosis or timeout',async()=>{
    const ctx={exec:async()=>{throw Object.assign(new Error('terminated'),{code:null,signal:'SIGKILL',stdout:'',stderr:'',timedOut:false});}} as unknown as IExecutionContext;
    const result=await runVersionProbe('opencode','/qa/opencode',['--version'],ctx);
    expect(result).toMatchObject({exitCode:null,signal:'SIGKILL',timedOut:false});
    expect(defaultProbeStatus(result)).toBe('error');
  });

  it('retains compatibility with a normal nonzero exit that reports a version',async()=>{
    const ctx={exec:async()=>{throw Object.assign(new Error('nonzero'),{code:1,stdout:'1.18.25',stderr:''});}} as unknown as IExecutionContext;
    expect(defaultProbeStatus(await runVersionProbe('opencode','/qa/opencode',['--version'],ctx))).toBe('available');
  });
});

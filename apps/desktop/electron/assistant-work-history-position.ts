import {mkdir,readFile,writeFile,rename} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {WorkHistoryPosition} from './assistant-work-history'
const position=z.object({after:z.number().int().nonnegative().safe(),retry:z.array(z.number().int().positive().safe())})
/** Scan acknowledgements only. Message bodies remain in the original inbox. */
export function assistantWorkHistoryPosition(home:string) {
  const directory=join(home,'assistant-work-history')
  const path=(owner:string)=>join(directory,`${encodeURIComponent(owner)}.json`)
  return {
    async read(owner:string):Promise<WorkHistoryPosition>{
      try{return position.parse(JSON.parse(await readFile(path(owner),'utf8')))}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {after:0,retry:[]};throw error}
    },
    async write(owner:string,value:WorkHistoryPosition){
      await mkdir(directory,{recursive:true,mode:0o700})
      const temporary=path(owner)+'.'+randomUUID()+'.tmp'
      await writeFile(temporary,JSON.stringify(position.parse(value)),{mode:0o600})
      await rename(temporary,path(owner))
    },
  }
}

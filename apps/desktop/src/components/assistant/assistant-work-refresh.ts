/** One read at a time; changes during it request one following read. */
export function assistantWorkRefresh(read:()=>Promise<void>) {
  let active:Promise<void>|null=null,dirty=false,closed=false
  return {
    refresh() {
      if(closed)return Promise.resolve()
      dirty=true
      if(!active) active=(async()=>{
        do {dirty=false;await read()} while(dirty&&!closed)
      })().finally(()=>{active=null})
      return active
    },
    close(){closed=true;dirty=false},
  }
}

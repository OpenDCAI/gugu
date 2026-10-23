import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { downloadSessionFile, uploadSessionFile, uploadSessionFiles } from '@gugu/core/local/agent/sessionFileHandoff'
import { withSessionAttachments } from '@gugu/core/cloud/sessionAttachments'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const directory = async () => { const dir=await mkdtemp(join(tmpdir(),'session-file-test-'));dirs.push(dir);return dir }
const original = new Uint8Array([0,255,12,45,0,128,17])
const ref={attachment_id:randomUUID(),file_name:'original.bin',sha256:createHash('sha256').update(original).digest('hex'),size_bytes:original.length,content_type:'application/octet-stream'}
function fixture(options: { denied?: boolean; corrupt?: boolean; revokeAfterDownload?: boolean } = {}) {
 let resolutions=0
 const fetcher=vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const path=String(url)
  if (path.endsWith('/upload')) return Response.json({staging_key:'staging/owner/upload',url:'https://objects.test/upload',fields:{},max_bytes:100,method:'PUT'})
  if (path==='https://objects.test/upload') return new Response(null,{status:204})
  if (path.endsWith('/session-commit')) return Response.json({attachment:{...ref,attachment_id:JSON.parse(String(init?.body)).attachment_id}})
  if (path.endsWith('/session-urls')) {
   resolutions++
   const body=JSON.parse(String(init?.body))
   expect(body.as).toBe('receiver')
   return Response.json({attachments:options.denied || options.revokeAfterDownload && resolutions>1 ? [] : [{...ref,url:'https://objects.test/original',expires_at:'later'}]})
  }
  if (path==='https://objects.test/original') return new Response(options.corrupt ? new Uint8Array([9]) : original)
  throw new Error('Unexpected request '+path)
 })
 return { endpoint:{supabaseUrl:'https://backend.test',anonKey:'public',token:'owner-token',fetch:fetcher},fetcher }
}
it('uploads complete binary bytes; receiver downloads and verifies the original without text or chat membership',async()=>{
 const root=await directory();const input=join(root,'original.bin');await writeFile(input,original)
 const fx=fixture()
 const receipt=await uploadSessionFile(fx.endpoint,{file_path:input},{agentId:'sender',sessionId:'s',recipients:['receiver']})
 expect(receipt.sha256).toBe(ref.sha256)
 const sent=fx.fetcher.mock.calls.find(([url])=>String(url).endsWith('/session-commit'))!
 expect(JSON.parse(String(sent[1]?.body))).toMatchObject({sender_user_id:'sender',recipient_user_ids:['receiver']})
 const downloaded=await downloadSessionFile(fx.endpoint,ref.attachment_id,'receiver',join(root,'download'))
 expect(new Uint8Array(await readFile(downloaded.file_path))).toEqual(original)
 expect(downloaded.sha256).toBe(ref.sha256)
 expect(withSessionAttachments('report',[ref])).toContain(ref.attachment_id)
 expect(withSessionAttachments('report',[ref])).not.toContain('https://objects.test')
})
it.each([{denied:true},{corrupt:true},{revokeAfterDownload:true}])('never exposes a file after denied, corrupt or revoked reads: %j',async options=>{
 const root=await directory();const fx=fixture(options)
 await expect(downloadSessionFile(fx.endpoint,ref.attachment_id,'receiver',root)).rejects.toThrow()
 expect(await readdir(root)).toEqual([])
 if(options.denied)expect(fx.fetcher.mock.calls.some(([url])=>String(url).includes('objects.test'))).toBe(false)
})
it('refuses an altered registered phone file before any upload',async()=>{
 const root=await directory();const file=join(root,'original.bin');await writeFile(file,original)
 const fx=fixture()
 await expect(uploadSessionFile(fx.endpoint,{file_path:file},{agentId:'sender',sessionId:'s',recipients:['receiver'],expectedSha256:'00'.repeat(32)})).rejects.toThrow(/changed/)
 expect(fx.fetcher).not.toHaveBeenCalled()
})

it('validates every local file before uploading any attachment', async () => {
 const root = await directory(); const file = join(root, 'original.bin'); await writeFile(file, original)
 const fx = fixture()
 await expect(uploadSessionFiles(fx.endpoint, [{ file_path: file }, { file_path: join(root, 'missing') }], { agentId: 'sender', sessionId: 's', recipients: ['receiver'] })).rejects.toThrow()
 expect(fx.fetcher).not.toHaveBeenCalled()
})

it('revokes prepared references if a later file fails before delivery', async () => {
 const root = await directory(); const file = join(root, 'original.bin'); await writeFile(file, original)
 const fx = fixture(); const prepared: string[] = []; const revoked: string[] = []; let commits = 0
 const base = fx.endpoint.fetch
 const endpoint = { ...fx.endpoint, fetch: async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).endsWith('/session-commit')) {
   if (++commits > 1) return Response.json({ error: 'denied', message: 'permission revoked' }, { status: 403 })
   prepared.push(JSON.parse(String(init?.body)).attachment_id)
  }
  if (String(url).endsWith('/session-revoke')) { revoked.push(JSON.parse(String(init?.body)).attachment_id); return Response.json({ ok: true }) }
  return base(url, init)
 } }
 await expect(uploadSessionFiles(endpoint, [{ file_path: file }, { file_path: file }], { agentId: 'sender', sessionId: 's', recipients: ['receiver'] })).rejects.toThrow(/permission revoked/)
 expect(prepared).toHaveLength(1); expect(revoked).toEqual(prepared)
})

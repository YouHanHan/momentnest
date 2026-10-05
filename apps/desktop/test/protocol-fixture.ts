import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Receiver } from '../src/service/receiver.ts'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import type { Library, Receipt } from '../src/service/types.ts'

const root=await mkdtemp(join(tmpdir(),'jinchuan-protocol-'))
await mkdir(join(root,'state'));await mkdir(join(root,'photos'))
const receiver=new Receiver(join(root,'state'))
await receiver.addDirectory(join(root,'photos'),'library')
await receiver.start(0,'127.0.0.1')
const pairing=receiver.pairInfo()
pairing.addresses=[`https://127.0.0.1:${receiver.port}`]
process.stdout.write(JSON.stringify({pairing,libraryId:receiver.store.list<Library>('library')[0].id})+'\n')
const lines=createInterface({input:process.stdin})
lines.on('line',async line=>{
  const command=JSON.parse(line)
  if(command.type==='redirect') {
    receiver.server!.removeAllListeners('request')
    receiver.server!.on('request',(_request,response)=>{response.writeHead(302,{location:'https://example.invalid/blocked'});response.end()})
    process.stdout.write(JSON.stringify({redirect:true})+'\n')
  }
  if(command.type==='verify') {
    const files=receiver.store.list<Receipt>('file')
    const results=[]
    for(const file of files)results.push({hash:createHash('sha256').update(await readFile(join(root,'photos',file.relativePath))).digest('hex'),path:file.relativePath})
    process.stdout.write(JSON.stringify({files:results})+'\n')
  }
  if(command.type==='close'){await receiver.close();lines.close();process.exit(0)}
})

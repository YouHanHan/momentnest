import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

const mime:Record<string,string>={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.jpe':'image/jpeg','.jfif':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif','.heic':'image/heic','.heif':'image/heif','.tif':'image/tiff','.tiff':'image/tiff','.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska','.avi':'video/x-msvideo','.3gp':'video/3gpp'}

/** 对已授权文件提供有限的本地流，视频拖动进度时按 Range 读取。 */
export async function mediaResponse(path:string,method:string,range:string|null):Promise<Response> {
  if(method!=='GET'&&method!=='HEAD') return new Response(null,{status:405})
  const info=await stat(path)
  if(!info.isFile()) return new Response(null,{status:404})
  const headers=new Headers({'Content-Type':mime[extname(path).toLowerCase()]??'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'"})
  let start=0,end=info.size-1,status=200
  if(range) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(range)
    if(!match||(match[1]===''&&match[2]==='')) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${info.size}`}})
    if(match[1]==='') start=Math.max(0,info.size-Number(match[2]))
    else {start=Number(match[1]);if(match[2]!=='') end=Math.min(end,Number(match[2]))}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=info.size||end<start) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${info.size}`}})
    headers.set('Content-Range',`bytes ${start}-${end}/${info.size}`);status=206
  }
  headers.set('Content-Length',String(Math.max(0,end-start+1)))
  if(method==='HEAD'||info.size===0) return new Response(null,{status,headers})
  const stream=createReadStream(path,{start,end})
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>,{status,headers})
}

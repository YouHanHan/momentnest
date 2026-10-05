import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import sharp from 'sharp'
import ffmpegPath from 'ffmpeg-static'

const root=dirname(dirname(fileURLToPath(import.meta.url)))
const source=join(root,'.cache','smoke-media'), archive=join(root,'.cache','smoke-archive'), output=join(root,'.cache','smoke-watermarks')
for(const directory of [source,archive,output]) await mkdir(directory,{recursive:true})
const sample=join(root,'design','layout-preview','assets','family-demo.png')
const base=await sharp(sample).extract({left:0,top:0,width:512,height:512}).jpeg().toBuffer()
await sharp(base).withExif({IFD2:{DateTimeOriginal:'2026:09:15 10:20:00'}}).jpeg().toFile(join(source,'宝宝参考.jpg'))
await sharp(base).resize(480,480).withExif({IFD2:{DateTimeOriginal:'2026:09:16 10:20:00'}}).jpeg().toFile(join(source,'相同人物.jpg'))
await sharp({create:{width:640,height:480,channels:3,background:'#bbccb0'}}).jpeg().toFile(join(source,'创建日期.jpg'))
await new Promise((resolve,reject)=>execFile(ffmpegPath,['-v','error','-nostdin','-loop','1','-i',join(source,'宝宝参考.jpg'),'-t','2','-vf','scale=320:320','-pix_fmt','yuv420p','-c:v','libx264','-metadata','creation_time=2026-09-17T12:00:00Z','-y',join(source,'宝宝视频.mp4')],{windowsHide:true},error=>error?reject(error):resolve()))
console.log(JSON.stringify({source,archive,output}))

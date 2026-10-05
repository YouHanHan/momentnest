import type { BabyProfile, MediaQuery, SimilarFaceQuery, WatermarkOptions } from '../shared/family'

export function record(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error('参数必须是对象。')
  return value as Record<string,unknown>
}
export function id(value:unknown):string {
  if(typeof value!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw new Error('记录标识无效。')
  return value
}
export function ids(value:unknown):string[] {
  if(!Array.isArray(value)||value.length<1||value.length>500) throw new Error('每次最多处理 500 个文件。')
  return [...new Set(value.map(id))]
}
/** 整理只接收本次来源标识；空选择代表跳过全部，拒绝整份客户端方案。 */
export function groupingIds(value:unknown):string[]|undefined {
  if(value===undefined) return undefined
  if(!Array.isArray(value)||value.length>10000) throw new Error('整理选择参数无效。')
  return [...new Set(value.map(id))]
}
export function matchScope(value:unknown,libraryId:unknown):'library'|'all' {
  const result=value===undefined?(libraryId===undefined?'all':'library'):choice(value,['library','all'] as const)
  if(result==='library') id(libraryId)
  else if(libraryId!==undefined) throw new Error('全部授权目录查找不能限定单个照片库。')
  return result
}
/** 档案和参考变更可明确重算全部授权库，默认仍使用当前照片库。 */
export function optionalMatchScope(value:unknown):'library'|'all'|undefined { return value===undefined?undefined:choice(value,['library','all'] as const) }
export function text(value:unknown,max=80):string {
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f]/.test(value)) throw new Error('文本参数无效。')
  return value.trim()
}
export function bool(value:unknown):boolean {
  if(typeof value!=='boolean') throw new Error('开关参数无效。')
  return value
}
export function date(value:unknown):string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期格式无效。')
  const parsed=new Date(`${value}T00:00:00Z`)
  if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value) throw new Error('日期无效。')
  return value
}
function integer(value:unknown,min:number,max:number):number {
  if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max) throw new Error('数值参数超出范围。')
  return value
}
/** 跳过记录按页读取，拒绝负数、小数及过大的页码。 */
export function warningPage(value:unknown):number {
  return value===undefined?1:integer(value,1,1000000)
}
function choice<T extends string>(value:unknown,allowed:readonly T[]):T {
  if(typeof value!=='string'||!allowed.includes(value as T)) throw new Error('选项参数无效。')
  return value as T
}
export function query(value:unknown):MediaQuery {
  const source=record(value), result:MediaQuery={}
  if(source.libraryId!==undefined) result.libraryId=id(source.libraryId)
  if(source.scope!==undefined) { result.scope=matchScope(source.scope,source.libraryId); if(source.babyId===undefined&&source.referenceBabyId===undefined) throw new Error('宝宝查询范围需要宝宝标识。') }
  if(source.page!==undefined) result.page=integer(source.page,0,100000)
  if(source.limit!==undefined) result.limit=integer(source.limit,1,200)
  if(source.kind!==undefined) result.kind=choice(source.kind,['photo','video'] as const)
  if(source.babyId!==undefined) result.babyId=id(source.babyId)
  if(source.referenceBabyId!==undefined) result.referenceBabyId=id(source.referenceBabyId)
  if(source.personId!==undefined) result.personId=id(source.personId)
  if(source.source!==undefined) result.source=choice(source.source,['folder','phone'] as const)
  for(const field of ['favorite','candidates','includeCandidates','unconfirmed','datePending','ungroupedFaces'] as const) if(source[field]!==undefined) result[field]=bool(source[field])
  if(result.ungroupedFaces&&result.personId) throw new Error('待归组查询不能同时限定人物。')
  if(result.includeCandidates&&(!result.babyId||result.candidates)) throw new Error('全部匹配需要宝宝标识，且不能同时限定待确认。')
  if(result.unconfirmed&&(!result.babyId||result.candidates||result.includeCandidates)) throw new Error('待核对查询需要宝宝标识，且不能同时限定疑似或全部匹配。')
  if(source.from!==undefined) result.from=date(source.from)
  if(source.to!==undefined) result.to=date(source.to)
  if(source.search!==undefined) result.search=source.search===''?'':text(source.search,120)
  if(source.dateSource!==undefined) result.dateSource=choice(source.dateSource,['capture','creation','manual','unknown'] as const)
  if(source.order!==undefined) result.order=choice(source.order,['asc','desc'] as const)
  return result
}
/** 相似查找只接受明确的人脸参考和查询范围，不继承日期或旧人物分组筛选。 */
export function similarQuery(value:unknown):SimilarFaceQuery {
  const source=record(value)
  const allowed=new Set(['assetId','faceId','scope','libraryId','page','limit','kind','order'])
  if(Object.keys(source).some(key=>!allowed.has(key))) throw new Error('相似人脸查询包含不支持的筛选。')
  const result:SimilarFaceQuery={assetId:id(source.assetId),faceId:id(source.faceId),scope:choice(source.scope,['library','all'] as const)}
  if(result.scope==='library') result.libraryId=id(source.libraryId)
  else if(source.libraryId!==undefined) throw new Error('全部目录查找不能限定单个照片库。')
  if(source.page!==undefined) result.page=integer(source.page,1,1000000)
  if(source.limit!==undefined) result.limit=integer(source.limit,1,100)
  if(source.kind!==undefined) result.kind=choice(source.kind,['photo','video'] as const)
  if(source.order!==undefined) result.order=choice(source.order,['asc','desc'] as const)
  return result
}
export function baby(value:unknown):BabyProfile {
  const source=record(value)
  if(!Array.isArray(source.referenceFaces)||source.referenceFaces.length>20) throw new Error('每个宝宝最多保留 20 个参考。')
  return {id:id(source.id),name:text(source.name),birthday:date(source.birthday),autoMatch:bool(source.autoMatch),
    referenceFaces:source.referenceFaces.map(item=>{const ref=record(item);return {assetId:id(ref.assetId),faceId:id(ref.faceId)}}),
    ...(source.avatarAssetId===undefined?{}:{avatarAssetId:id(source.avatarAssetId)}),
    updatedAt:new Date().toISOString()}
}
export function watermark(value:unknown):WatermarkOptions {
  const source=record(value)
  if(typeof source.color!=='string'||!/^#[0-9a-fA-F]{6}$/.test(source.color)) throw new Error('水印颜色无效。')
  if(typeof source.opacity!=='number'||!Number.isFinite(source.opacity)||source.opacity<0.1||source.opacity>1) throw new Error('水印透明度无效。')
  const result:WatermarkOptions={babyId:id(source.babyId),position:choice(source.position,['top-left','top-right','bottom-left','bottom-right']),
    fontSize:integer(source.fontSize,10,200),color:source.color,opacity:source.opacity,
    showName:bool(source.showName),showAge:bool(source.showAge),showDayCount:bool(source.showDayCount),showDate:bool(source.showDate)}
  if(source.template!==undefined) result.template=choice(source.template,['growth','classic'] as const)
  if(source.growthMode!==undefined) result.growthMode=choice(source.growthMode,['auto','day-count'] as const)
  if(source.shade!==undefined) result.shade=bool(source.shade)
  return result
}

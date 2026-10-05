import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execute=promisify(execFile)
type Interfaces=Record<string,NetworkInterfaceInfo[]|undefined>

/** 只接受规范 IPv4 字面量，拒绝域名、简写、八进制和 IPv6 映射地址。 */
export function ipv4(value:string|undefined):number|null {
  if(!value || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return null
  const octets=value.split('.').map(Number)
  if(octets.some(part=>part>255)) return null
  return octets.reduce((result,part)=>result*256+part,0)>>>0
}

export function isLanAddress(value:string|undefined):boolean {
  const n=ipv4(value)
  if(n===null) return false
  return (n>>>24)===10 || (n>>>20)===(0xac100000>>>20) || (n>>>16)===0xc0a8 ||
    (n>=0xa9fe0100 && n<=0xa9fefeff)
}

/** 要求来源与接收地址位于物理网卡的同一私有子网，不接收路由转发网段。 */
export function isLocalPeer(remote:string|undefined,local:string|undefined,interfaces:Interfaces,physical:ReadonlySet<string>):boolean {
  if(!isLanAddress(remote)||!isLanAddress(local)) return false
  const peer=ipv4(remote)!
  return Object.entries(interfaces).some(([name,items])=>physical.has(name)&&(items??[]).some(item=>{
    if(item.family!=='IPv4'||item.internal||item.address!==local) return false
    const mask=ipv4(item.netmask),address=ipv4(item.address)
    if(mask===null||address===null||mask===0||mask===0xffffffff) return false
    const hostMask=(~mask)>>>0
    if((hostMask&(hostMask+1))!==0) return false
    const network=(address&mask)>>>0,broadcast=(network|hostMask)>>>0
    return ((peer&mask)>>>0)===network && peer!==network && peer!==broadcast
  }))
}

export class LanAccess {
  private physical=new Set<string>()
  private timer?:ReturnType<typeof setInterval>
  private refreshing=false
  private loopback=false

  async start(loopback:boolean):Promise<void> {
    this.loopback=loopback
    if(loopback) return
    await this.refresh()
    this.timer=setInterval(()=>{void this.refresh()},30000)
    this.timer.unref()
  }

  /** Windows 只读查询物理网卡，识别失败时拒绝网络接收，不退回全网卡。 */
  private async refresh():Promise<void> {
    if(this.refreshing) return
    this.refreshing=true
    try {
      if(process.platform!=='win32') {this.physical.clear();return}
      const shell=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe')
      const command="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;ConvertTo-Json -Compress -InputObject @(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Select-Object -ExpandProperty Name)"
      const {stdout}=await execute(shell,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000,maxBuffer:65536})
      const names:unknown=JSON.parse(stdout.replace(/^\uFEFF/,''))
      if(!Array.isArray(names)||names.some(name=>typeof name!=='string')) throw Error('网卡信息无效')
      this.physical=new Set(names)
    } catch {this.physical.clear()} finally {this.refreshing=false}
  }

  allows(remote:string|undefined,local:string|undefined):boolean {
    // 回环仅在测试显式绑定 127.0.0.1 时开放，发布接收端不开放此入口。
    return this.loopback?remote==='127.0.0.1'&&local==='127.0.0.1':isLocalPeer(remote,local,networkInterfaces(),this.physical)
  }

  addresses():string[] {
    if(this.loopback) return ['127.0.0.1']
    const interfaces=networkInterfaces()
    return Object.entries(interfaces).flatMap(([name,items])=>this.physical.has(name)?(items??[]).filter(item=>item.family==='IPv4'&&!item.internal&&isLanAddress(item.address)).map(item=>item.address):[])
  }

  close():void {if(this.timer) clearInterval(this.timer)}
}

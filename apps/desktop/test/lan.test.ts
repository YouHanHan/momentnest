import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NetworkInterfaceInfo } from 'node:os'
import { isLanAddress, isLocalPeer } from '../src/service/lan.ts'

test('局域网地址白名单拒绝公网、域名、IPv6 和歧义写法',()=>{
  for(const address of ['10.0.0.1','172.16.0.1','172.31.255.254','192.168.5.30','169.254.1.1','169.254.254.254']) assert.equal(isLanAddress(address),true,address)
  for(const address of ['8.8.8.8','172.15.1.1','172.32.1.1','100.64.0.1','198.18.0.1','192.0.2.1','0.0.0.0','127.0.0.1','224.0.0.1','255.255.255.255','169.254.0.1','169.254.255.1','example.com','192.168.001.1','192.168.1','3232235777','0xc0a80101','::1','::ffff:192.168.1.1','fc00::1','192.168.1.256']) assert.equal(isLanAddress(address),false,address)
})

test('接收来源必须属于物理网卡同一网段，拒绝公网、跨网段、虚拟网卡和广播',()=>{
  const nic=(address:string,netmask:string):NetworkInterfaceInfo=>({address,netmask,family:'IPv4',mac:'11:22:33:44:55:66',internal:false,cidr:null})
  const interfaces={WLAN:[nic('192.168.5.30','255.255.255.0')],VPN:[nic('10.2.0.1','255.255.255.0')],Public:[nic('203.0.113.2','255.255.255.0')]}
  const physical=new Set(['WLAN','Public'])
  assert.equal(isLocalPeer('192.168.5.20','192.168.5.30',interfaces,physical),true)
  for(const [remote,local] of [['8.8.8.8','192.168.5.30'],['192.168.6.20','192.168.5.30'],['10.2.0.2','10.2.0.1'],['192.168.5.0','192.168.5.30'],['192.168.5.255','192.168.5.30'],['203.0.113.3','203.0.113.2'],['::ffff:192.168.5.20','192.168.5.30'],['127.0.0.1','127.0.0.1']]) assert.equal(isLocalPeer(remote,local,interfaces,physical),false,`${remote} -> ${local}`)
  assert.equal(isLocalPeer('192.168.5.20','192.168.5.30',interfaces,new Set()),false)
})

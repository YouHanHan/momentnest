const {app}=require('electron')
const {resolve,join}=require('node:path')
const {mkdirSync}=require('node:fs')
const root=resolve(__dirname,'..')
// 使用隔离配置验证正式界面，测试照片和宝宝档案不会进入用户的相册记录。
const directory=join(root,'.cache','desktop-smoke')
mkdirSync(directory,{recursive:true})
app.setPath('userData',directory)
require(join(root,'apps','desktop','out','main','index.js'))

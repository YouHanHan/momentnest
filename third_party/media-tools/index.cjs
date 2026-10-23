const { join } = require('node:path')

// 路径只指向随项目准备或随应用分发的工具，不从系统 PATH 查找可执行文件。
const directory = join(__dirname, 'bin', `${process.platform}-${process.arch}`)
exports.ffmpegPath = join(directory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
exports.ffprobePath = join(directory, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
Object.freeze(module.exports)

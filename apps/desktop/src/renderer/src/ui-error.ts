/** 提取服务返回的可读错误，移除 Electron IPC 的技术包装。 */
export function userError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  let previous = ''
  while (message !== previous) {
    previous = message
    message = message.replace(/^(?:Error:\s*)?Error invoking remote method\s+['"][^'"]+['"]:\s*/, '').replace(/^Error:\s*/, '').trim()
  }
  return message || '操作未完成，请稍后重试。'
}

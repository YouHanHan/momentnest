/** 比较已经登记的规范目录；统一 Windows 大小写、分隔符和尾部分隔符。 */
export function copyDirectoryError(sourcePath: string, targetPath: string): string | null {
  if (!sourcePath || !targetPath) return null
  const normalize = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/g, '').toLowerCase()
  const source = normalize(sourcePath), target = normalize(targetPath)
  if (source === target) return '来源目录和归档目标不能是同一个目录，请选择其他目标。'
  if (target.startsWith(`${source}/`)) return '归档目标不能位于来源目录内部，请选择互不包含的目录。'
  if (source.startsWith(`${target}/`)) return '来源目录不能位于归档目标内部，请选择互不包含的目录。'
  return null
}

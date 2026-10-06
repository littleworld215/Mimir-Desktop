/** 显示名保留字形；归一名只trim/折叠空白/小写，不转换标点。 */
export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Verify the result before reporting success; never retain or log clipboard reads. */
export async function copyAssetText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  let actual: string
  try {
    actual = await navigator.clipboard.readText()
    if (typeof actual !== 'string') throw new Error('Invalid clipboard result')
  } catch {
    throw new Error('无法核验剪贴板内容，请重试。')
  }
  // Windows can represent LF as CRLF. Only the comparison is normalized.
  if (actual.replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n')) {
    throw new Error('未能确认剪贴板内容，请重试。')
  }
}

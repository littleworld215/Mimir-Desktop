/** Existing reading-note formatting; shared without loading stores or Electron. */
export function appendReadingNote(notes: string, text: string, now: Date): string {
  const body = text.trim()
  if (body === '') return notes
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const entry = `[${stamp}]\n${body}`
  return notes.trimEnd() === '' ? entry : `${notes.trimEnd()}\n\n${entry}`
}

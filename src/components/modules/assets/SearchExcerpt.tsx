export function SearchExcerpt({ excerpt }: { excerpt: { text: string; matches: { start: number; end: number }[] } }) {
  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const { start, end } of [...excerpt.matches].sort((a, b) => a.start - b.start)) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < cursor || end <= start || end > excerpt.text.length) continue
    parts.push(excerpt.text.slice(cursor, start), <mark key={start} className="bg-primary/15 text-foreground">{excerpt.text.slice(start, end)}</mark>)
    cursor = end
  }
  parts.push(excerpt.text.slice(cursor))
  return <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{parts}</p>
}

import { useEffect, useRef, useState } from 'react'
import { SPACE_CHANGED_EVENT } from '@/lib/agentContext'
import type { ArxivEntry, WebSearchEntry } from './types'

interface PaperMatch {
  source: WebSearchEntry
  candidates: ArxivEntry[]
  projectId: string | null
  generation: number
  trigger: HTMLElement | null
}

/** 网页标题只用于发现候选；异步返回不能自动触发写入。 */
export function useWebPaperMatch(projectId: string | null, onImported: () => Promise<void>, onError: (message: string) => void) {
  const [match, setMatch] = useState<PaperMatch | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const importing = useRef(false)
  const currentProject = useRef(projectId)
  currentProject.current = projectId

  useEffect(() => {
    const invalidate = () => { generation.current++; setMatch(null); setError('') }
    invalidate()
    window.addEventListener(SPACE_CHANGED_EVENT, invalidate)
    return () => { generation.current++; window.removeEventListener(SPACE_CHANGED_EVENT, invalidate) }
  }, [projectId])

  const current = (request: { generation: number; projectId: string | null }) =>
    request.generation === generation.current && request.projectId === currentProject.current

  const begin = async (source: WebSearchEntry) => {
    if (importing.current) return
    const request = { generation: ++generation.current, projectId, trigger: document.activeElement as HTMLElement | null }
    setMatch(null)
    setError('')
    try {
      const result = await window.electronAPI!.library.searchArxiv(source.title, 5)
      if (!current(request)) return
      if (!result.ok) throw Error(result.message || '候选检索失败，请重试')
      const candidates = result.entries as ArxivEntry[] | undefined
      if (!candidates?.length) { onError('未找到候选论文，请直接打开网页查看'); return }
      setMatch({ ...request, source, candidates })
    } catch (failure) {
      if (current(request)) onError(failure instanceof Error ? failure.message : '候选检索失败，请重试')
    }
  }

  const close = () => {
    if (importing.current) return
    generation.current++
    setMatch(null)
    setError('')
  }

  const confirm = async (candidate: ArxivEntry) => {
    if (!match || !current(match) || importing.current || !match.candidates.includes(candidate)) return
    importing.current = true
    setBusy(true)
    setError('')
    try {
      const result = await window.electronAPI!.library.importPaper(candidate, match.projectId ?? undefined)
      if (!current(match)) return
      if (!result.ok) throw Error(result.message || '导入失败，请重试')
      setMatch(null)
      try { await onImported() } catch { onError('论文已导入，列表刷新失败，请重新打开文献库') }
    } catch (failure) {
      if (current(match)) setError(failure instanceof Error ? failure.message : '导入失败，请重试')
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return { match, error, busy, begin, close, confirm }
}

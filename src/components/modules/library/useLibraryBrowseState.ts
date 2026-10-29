import { useCallback, useEffect, useRef, useState } from 'react'
import type { EvidenceScope } from '../../../../shared/libraryEvidenceContracts'
import { clearLibraryBrowseState, readLibraryBrowseState, writeLibraryBrowseState, type LibraryBrowseSnapshot } from '@/lib/libraryBrowseState'

export function useLibraryBrowseState(scope: EvidenceScope | undefined) {
  const scopeKey = scope ? JSON.stringify([scope.workspaceId, scope.spaceEpoch]) : ''
  const current = useRef(scopeKey), readyKey = useRef('')
  current.current = scopeKey
  const [result, setResult] = useState<{ key: string; restored?: LibraryBrowseSnapshot; warning: string }>({ key: '', warning: '' })
  useEffect(() => {
    readyKey.current = ''
    if (!scope) { setResult({ key: '', warning: '' }); return }
    let reply: ReturnType<typeof readLibraryBrowseState>
    try { reply = readLibraryBrowseState(window.localStorage, scope.workspaceId) }
    catch { reply = { warning: '无法读取本机浏览位置，当前资料不受影响。' } }
    if (current.current !== scopeKey) return
    readyKey.current = scopeKey
    setResult({ key: scopeKey, restored: reply.state, warning: reply.warning ?? '' })
    return () => { readyKey.current = '' }
  }, [scopeKey])
  const persist = useCallback((state: LibraryBrowseSnapshot) => {
    if (!scope || current.current !== scopeKey || readyKey.current !== scopeKey) return
    let message = ''
    try { const reply = writeLibraryBrowseState(window.localStorage, scope.workspaceId, state); message = reply.message ?? '' }
    catch { message = '无法保存本机浏览位置，当前操作与资料不受影响。' }
    setResult(previous => previous.key === scopeKey && previous.warning !== message ? { ...previous, warning: message } : previous)
  }, [scopeKey])
  const clear = useCallback(() => {
    if (!scope || current.current !== scopeKey || readyKey.current !== scopeKey) return
    let message = ''
    try { message = clearLibraryBrowseState(window.localStorage, scope.workspaceId).message ?? '' }
    catch { message = '无法清除本机浏览位置，请检查浏览器存储。' }
    setResult(previous => previous.key === scopeKey ? { key: scopeKey, restored: message ? previous.restored : undefined, warning: message } : previous)
  }, [scopeKey])
  return { ready: Boolean(scopeKey && result.key === scopeKey), restored: result.key === scopeKey ? result.restored : undefined, warning: result.key === scopeKey ? result.warning : '', persist, clear }
}

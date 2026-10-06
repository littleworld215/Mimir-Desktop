import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from './assetsUi'
/** Read-only preview owns a generation; clearing, replacing or unmounting invalidates old results. */
export function useAssetPreview<T>() {
  const [value, setValue] = useState<T | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const generation = useRef(0), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++generation.current } }, [])
  const clear = useCallback(() => { ++generation.current; setValue(null); setLoading(false); setError('') }, [])
  const read = useCallback(async (operation: () => Promise<T>): Promise<T | null> => {
    const ticket = ++generation.current
    setLoading(true); setError(''); setValue(null)
    try { const result = await operation(); if (!alive.current || ticket !== generation.current) return null; setValue(result); return result }
    catch (error) { if (alive.current && ticket === generation.current) setError(errorMessage(error)); return null }
    finally { if (alive.current && ticket === generation.current) setLoading(false) }
  }, [])
  return { value, loading, error, clear, read }
}

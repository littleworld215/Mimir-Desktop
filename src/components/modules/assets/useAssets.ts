import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssetCategory, AssetDetail, AssetListQuery, AssetPage, AssetTag, WorkspaceRequest } from '../../../../shared/assetsContracts'
import { assetsApi } from './assetsApi'
import { errorMessage, useAssetsEditorGuard } from './assetsUi'

export function useAssets() {
  const [scope, setScope] = useState<WorkspaceRequest | null>(null)
  const scopeRef = useRef<WorkspaceRequest | null>(null)
  const [query, setQuery] = useState<AssetListQuery>({ page: 1, pageSize: 30, archived: 'exclude' })
  const [page, setPage] = useState<AssetPage>({ items: [], total: 0, page: 1, pageSize: 30 })
  const [categories, setCategories] = useState<AssetCategory[]>([])
  const [tags, setTags] = useState<AssetTag[]>([])
  const [selected, setSelected] = useState<AssetDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(false), listSeq = useRef(0), detailSeq = useRef(0), writing = useRef(false)
  useAssetsEditorGuard({ isDirty: () => false, isBusy: () => writing.current, save: async () => false, discard: () => {} })
  const refresh = useCallback(async () => {
    const seq = ++listSeq.current
    setLoading(true); setError('')
    try {
      const context = scopeRef.current ?? (await assetsApi.context()).context
      if (!alive.current || seq !== listSeq.current) return
      scopeRef.current = context; setScope(context)
      const [assets, cats, tagList] = await Promise.all([assetsApi.list({ ...context, ...query }), assetsApi.listCategories({ ...context, archived: query.archived }), assetsApi.listTags(context)])
      if (!alive.current || seq !== listSeq.current) return
      setPage(assets.page); setCategories(cats.categories); setTags(tagList.tags)
    } catch (error) { if (alive.current && seq === listSeq.current) setError(errorMessage(error)) }
    finally { if (alive.current && seq === listSeq.current) setLoading(false) }
  }, [query])
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; ++listSeq.current; ++detailSeq.current } }, [refresh])
  async function select(id: number | null) {
    const seq = ++detailSeq.current
    setSelected(null); setDetailLoading(id !== null); setError('')
    if (id === null || !scopeRef.current) return
    try {
      const result = await assetsApi.get({ ...scopeRef.current, assetId: id })
      if (alive.current && seq === detailSeq.current) setSelected(result.asset)
    } catch (error) { if (alive.current && seq === detailSeq.current) setError(errorMessage(error)) }
    finally { if (alive.current && seq === detailSeq.current) setDetailLoading(false) }
  }
  async function write<T>(operation: (context: WorkspaceRequest) => Promise<T>): Promise<T> {
    if (!scopeRef.current || !alive.current) throw new Error('空间不可用，请重新打开资产库。')
    if (writing.current) throw new Error('另一项资产操作正在进行，请稍后再试。')
    writing.current = true; setBusy(true)
    try { return await operation(scopeRef.current) }
    finally { writing.current = false; if (alive.current) setBusy(false) }
  }
  function accept(asset: AssetDetail | null) { ++detailSeq.current; if (alive.current) { setSelected(asset); setDetailLoading(false) } }
  return { scope, query, setQuery, page, categories, tags, selected, loading, detailLoading, busy, error, setError, refresh, select, write, accept }
}

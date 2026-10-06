/**
 * 资产库模块（I0-05 骨架）。
 *
 * 只做**最小真实通路**：取当前科研空间上下文 → 查询资产列表，然后展示
 * **真实空态**或**真实错误**。刻意不放假数据、假列表：没有资产就显示空态，
 * 桥接 / 空间不可用就显示可操作错误（含重试）。
 *
 * 完整的列表、详情、编辑器、分类树与标签治理在 I1 实现（见整合计划 §4）。
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Boxes, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { AssetPage, WorkspaceRequest } from '../../../../shared/assetsContracts'
import { AssetsApiError, getWorkspaceContext, listAssets } from './assetsApi'

type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; context: WorkspaceRequest; page: AssetPage }
  | { kind: 'error'; message: string }

export function Assets(): React.JSX.Element {
  const [state, setState] = useState<ViewState>({ kind: 'loading' })

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' })
    try {
      const context = await getWorkspaceContext()
      const page = await listAssets(context)
      setState({ kind: 'ready', context, page })
    } catch (error) {
      setState({
        kind: 'error',
        message:
          error instanceof AssetsApiError ? error.message : '资产库加载失败，请重试。'
      })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Boxes className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-medium">资产库</h1>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={state.kind === 'loading'}>
          <RefreshCw className="mr-1 h-4 w-4" />
          刷新
        </Button>
      </header>

      {state.kind === 'loading' && (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          正在读取当前科研空间…
        </div>
      )}

      {state.kind === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <AlertCircle className="h-6 w-6 text-destructive" />
          <p className="max-w-md text-sm text-muted-foreground">{state.message}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}

      {state.kind === 'ready' && (
        <div className="flex flex-1 flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            当前科研空间：{state.context.workspaceId} ｜ 资产 {state.page.total} 条
          </p>
          {state.page.total === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <Boxes className="h-8 w-8 opacity-40" />
              <p className="text-sm">这个科研空间还没有资产。</p>
              <p className="text-xs">资产的创建与管理将在后续阶段接入。</p>
            </div>
          ) : (
            <p className="text-sm">已读取 {state.page.items.length} 条（列表视图在后续阶段实现）。</p>
          )}
        </div>
      )}
    </div>
  )
}

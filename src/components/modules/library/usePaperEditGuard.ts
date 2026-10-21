import { useEffect, useRef } from 'react'
import { registerEvidenceEditor, type EvidenceEditorSession } from '@/lib/evidenceEditGuard'

/** 复用宿主离开流程；回调读取最新草稿，注册不随每次输入重复建立。 */
export function usePaperEditGuard(session: EvidenceEditorSession) {
  const latest = useRef(session)
  latest.current = session
  useEffect(() => registerEvidenceEditor({
    isDirty: () => latest.current.isDirty(),
    isBusy: () => latest.current.isBusy(),
    save: () => latest.current.save(),
    discard: () => latest.current.discard()
  }), [])
}

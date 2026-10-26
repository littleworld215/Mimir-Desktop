/** 已核对持久化结构的路径引用；不按未知嵌套字段名猜测业务语义。 */
export interface StructuredPathReference {
  readonly storeKey: string
  readonly locator: string
  readonly field: string
  readonly container: object
  readonly kind: 'pdf' | 'project' | 'artifact'
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function collectPathReferences(store: Record<string, unknown>, options: { includeNonString?: boolean } = {}): StructuredPathReference[] {
  const refs: StructuredPathReference[] = []
  const add = (container: object, field: string, storeKey: string, locator: string, kind: StructuredPathReference['kind']) => {
    const value: unknown = Reflect.get(container, field)
    if (Object.hasOwn(container, field) && (typeof value === 'string' || (options.includeNonString && value !== null && value !== undefined))) refs.push({ container, field, storeKey, locator, kind })
  }
  for (const [storeKey, field, kind] of [['library:papers', 'pdfPath', 'pdf'], ['library:projects', 'paperDir', 'project']] as const) {
    const table = store[storeKey]
    if (Array.isArray(table)) table.forEach((row, i) => { if (record(row)) add(row, field, storeKey, `[${i}]`, kind) })
    else if (record(table)) for (const [id, row] of Object.entries(table)) if (record(row)) add(row, field, storeKey, id, kind)
  }
  const recent = store['paper.recentProjects']
  if (Array.isArray(recent)) recent.forEach((row, i) => { if (record(row)) add(row, 'dir', 'paper.recentProjects', `[${i}]`, 'project') })
  const conversations = store['chat:conversations']
  if (Array.isArray(conversations)) conversations.forEach((conversation, c) => {
    if (!record(conversation) || !Array.isArray(conversation.messages)) return
    conversation.messages.forEach((message, m) => {
      if (!record(message)) return
      const base = `[${c}].messages[${m}]`
      if (Array.isArray(message.artifacts)) message.artifacts.forEach((artifact, a) => {
        if (record(artifact)) add(artifact, 'path', 'chat:conversations', `${base}.artifacts[${a}].path`, 'artifact')
      })
      if (!record(message.run) || !Array.isArray(message.run.steps)) return
      message.run.steps.forEach((step, s) => {
        if (!record(step) || !Array.isArray(step.artifacts)) return
        step.artifacts.forEach((_artifact, a) => add(step.artifacts as unknown[], String(a), 'chat:conversations', `${base}.run.steps[${s}].artifacts[${a}]`, 'artifact'))
      })
    })
  })
  return refs
}

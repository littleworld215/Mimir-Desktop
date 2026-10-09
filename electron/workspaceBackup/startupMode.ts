export function startupMode(args: string[]): 'normal' | 'maintenance' {
  if (!args.includes('--workspace-maintenance')) return 'normal'
  if (args.includes('--assets-mcp')) throw Error('维护模式不能同时启用外部MCP。')
  return 'maintenance'
}

/** 公共工具描述与严格参数schema；协议SDK和已有业务服务分别校验，模型提示不是授权。 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { MCP_WRITE_TOOLS } from './broker'

const text = { type: 'string', maxLength: 1024 * 1024 }
const code = { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 100 }
const positive = { type: 'integer', minimum: 1 }
const kind = { type: 'string', enum: ['thought', 'rule', 'file', 'prompt'] }
const tags = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 80 }, maxItems: 100 }
const confirm = { type: 'boolean' }
const maxChars = { type: 'integer', minimum: 1, maximum: 32000 }
function tool(name: string, description: string, properties: Record<string, object> = {}, required: string[] = []): Tool {
  const write = (MCP_WRITE_TOOLS as readonly string[]).includes(name)
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: false } }
}
export const ASSET_MCP_TOOLS: Tool[] = [
  tool('search_assets', '只读搜索摘要；tagCodes沿用历史名称，值为标签名。', { query: text, categoryCode: code, tagCodes: tags, kind, page: positive, pageSize: { ...positive, maximum: 100 } }),
  tool('get_asset', '读取当前正文或文件元信息；最多32000 UTF-16单元，截断有标记。', { assetCode: code, maxChars }, ['assetCode']),
  tool('get_asset_version', '读取不可变历史版本；文件不返回路径或二进制。', { assetCode: code, version: positive, maxChars }, ['assetCode', 'version']),
  tool('list_categories', '只读分类树'), tool('list_tags', '只读标签及使用数'),
  tool('get_refgraph', '只读有界参见图', { assetCode: code, depth: { ...positive, maximum: 3 } }, ['assetCode']),
  tool('list_saved_filters', '只读保存筛选'),
  tool('create_asset', '创建文本；confirm=true之后仍需桌面用户批准。', { name: { ...text, maxLength: 200 }, content: text, categoryCode: code, kind, tags, sourceTask: text, confirm, requestId: { ...text, maxLength: 200 } }, ['name', 'content', 'categoryCode', 'confirm']),
  tool('update_metadata', '修改元信息或追加正文；baseVersion为版本号，写入须桌面批准。', { assetCode: code, baseVersion: { type: 'integer', minimum: 0 }, name: { ...text, maxLength: 200 }, content: text, description: text, categoryCode: code, confirm }, ['assetCode', 'baseVersion', 'confirm']),
  tool('add_tags', '增加标签，须桌面批准', { assetCode: code, tags, confirm }, ['assetCode', 'tags', 'confirm']),
  tool('remove_tags', '移除标签，须桌面批准', { assetCode: code, tags, confirm }, ['assetCode', 'tags', 'confirm']),
  tool('add_reference', '增加参见，须桌面批准', { assetCode: code, targetCode: code, confirm }, ['assetCode', 'targetCode', 'confirm']),
  tool('save_ai_draft', '保存外部结果为待采纳草稿；不调用模型，须桌面批准。', { assetCode: code, mode: { type: 'string', enum: ['polish', 'restructure'] }, content: text, confirm }, ['assetCode', 'mode', 'content', 'confirm']),
  tool('adopt_ai_draft', '条件采纳草稿为新版本或派生资产；不调用模型，须桌面批准。', { draftId: positive, carry: { type: 'string', enum: ['version', 'derived'] }, confirm }, ['draftId', 'confirm'])
]

export const ASSET_RESOURCE_TEMPLATES = [
  { uriTemplate: 'asset://{assetCode}', name: 'asset', description: '当前资产安全只读投影', mimeType: 'application/json' },
  { uriTemplate: 'asset://{assetCode}/version/{version}', name: 'asset-version', description: '指定历史版本安全投影', mimeType: 'application/json' },
  { uriTemplate: 'category://{code}', name: 'category', description: '分类与最多100条摘要（含分页信息）', mimeType: 'application/json' }
]
export const ASSET_MCP_PROMPTS = [
  { name: 'research_asset_review', description: '检索和复核；不自动执行工具或模型。', arguments: [
    { name: 'query', description: '检索词' }, { name: 'assetCodes', description: '已知代码，逗号分隔' }
  ] },
  { name: 'research_asset_restructure', description: '整理拟保存结果，展示后确认；不自动写入。', arguments: [
    { name: 'title', description: '标题', required: true }, { name: 'categoryCode', description: '分类代码', required: true },
    { name: 'kind', description: 'thought/rule/file/prompt' }, { name: 'content', description: '完整正文', required: true }
  ] }
]

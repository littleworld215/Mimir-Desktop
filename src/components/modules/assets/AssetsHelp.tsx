import {AssetModal} from './assetsUi'
export function AssetsHelp({onClose}:{onClose:()=>void}) {
  return <AssetModal title="资产库使用指南" onClose={onClose}><ol className="list-decimal space-y-3 pl-5 text-sm"><li>收集：新建文本、外链，或导入文件和 JSON；先检查导入预览。</li><li>整理：分类、标签、参见关系与批量整理；旧版本保持可追溯。</li><li>查找：全文检索、收藏、最近使用和保存筛选；Ctrl/Cmd+K 聚焦搜索。</li><li>取用：Ctrl/Cmd+Shift+K 打开快速取用；文本支持填值，所选资产可组合任务包。Ctrl/Cmd+Enter 复制，Esc 返回，多行 Enter 换行。</li><li>保存：修改资产后显式保存。任务包设置需要单独保存，仅存本机；导出原始资产可用于交换，不能代替完整文件备份。</li></ol><p className="text-xs text-muted-foreground">阅读预览不执行 HTML、不加载图片。复制和导出使用原始文本。指南不创建示例资产。</p></AssetModal>
}

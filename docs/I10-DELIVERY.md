# I10：科研计划整合进度

2026-10-20，状态：开发中，尚未完整交付。参考固定[Research-Workbench da1366ef](https://github.com/Layman-art/Research-Workbench/tree/da1366ef63966139325850f245770412ba6fb2a5)，MIT；当前独立适配重写，未直接复制其代码。来源项目[S-013/D-075与六批范围](https://github.com/littleworld215/research-asset-library/blob/main/docs/INTEGRATION-PLAN-I10.md)。

| 批次 | 状态 |
|---|---|
| 1 规格、存储与可信底座 | 专项22项与完整三闸门通过（1978通过/9既有跳过，exit0） |
| 2 项目、方向、记录与导航 | 待实现 |
| 3 待办、周期、周月日程、总览 | 待实现 |
| 4 草稿、批量、关联、导入导出 | 待实现 |
| 5 提醒、托盘、自启 | 待实现，默认关闭 |
| 6 自检恢复、桌面/目录包、复核 | 待完成 |

## 第一批的数据与接口

- 科研空间`.mimir/planning/planning.json`保存业务，`drafts.json`和`deliveries.json`独立修订。业务上限16MiB/10,000项，分页50；无文件只读返回默认定义与空记录，不创建目录。
- `researchPlanning:bootstrap/list/detail/save`使用固定桥，只有bootstrap可以无scope；其余绑定当前空间ID/代际，保存须expectedRevision。拒绝未知字段、伪造路径、非主窗口/子框架与旧空间。
- 原子发布校验来源/临时文件及父目录身份；冲突或磁盘失败保留原文件。删除采用持久标记，不允许从仓库移除实体；具体操作UI后续接入。
- 通用编辑草稿是未完成表单，可以没有标题或只填写一端时间；正式保存仍须完整合法。草稿不是AI产出，不能复用资产AI草稿表。
- 维护入口和普通退出等待科研计划任务实际结束；外层操作闸门返回稳定MAINTENANCE_BLOCKED。

当前未接用户界面、自检恢复与后台功能，不代表日常安装版已经可用。现有安装、真实空间、模型和I5/I6待验均不变。

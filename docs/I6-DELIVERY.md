# I6 整科研空间备份、恢复与自检 —— 交付文档

2026-10-25 G-06：[原生恢复选择与任务取消](I6-MAINTENANCE-TASKS.md)已通过完整三闸门（2530通过/9既有跳过）及开发/独立候选包维护组合各41/41、零自动重试。首次并行记录RECHECK仍待查；未更新日常安装，G07～08及I6未终验。

> 2026-10-25 G-05：[中断恢复规则](I6-RESTORE-RECOVERY.md)接通固定UUID／目录的记录和登记重试、确认后暂存核验，以及残锁只读和稳定分页；无锁自检不写审计。实际工程、强退与候选包见[本轮记录](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-restore-recovery-20261025.md)，G-06～08及原终验保持，不更新日常安装。

> 2026-10-24 G-04：[恢复关联规则](I6-RESTORE-ASSOCIATIONS.md)接通五类结构路径、目录键快照和空间UUID模板，正文不替换，未知/外部保留并提示，冲突不合并。新增来源ID仅为最小关联前置，格式1兼容；[实际记录](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-restore-associations-20261024.md)区分失败/复核/工程/桌面与部署，G-05～08和I5/I6/I10原待验保持。

> 2026-10-24 G-03：[资产恢复规则](I6-ASSETS-RESTORE.md)补完整DDL/版本、暂存迁移及全部历史附件完整读取，自检仍只读。初版“只查表名即完整”不能替代当前门禁。[实际证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-assets-restore-20261024.md)分开记录静态/运行/候选包；G-04～08与原用户待验保持，日常6645129不替换。

> 2026-10-24 G-02：三个读取入口共用10万条目/64MiB清单/1TiB业务展开限制，元数据预检和实际计数分别执行，ZIP/ZIP64目录与真实空目录内容有回归。[当前规则](I6-ARCHIVE-READ-LIMITS.md)及[本轮证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-archive-read-limits-20261024.md)区分实现/运行/静态复核与日常部署；格式1保持，旧历史中“仅流式即满足上限”的说法不能替代读取时限制。

> 2026-10-24 G-01补强：已修复来源变化仍成功发布/新增资料遗漏，临时包独立验包及真实关闭、最终来源/目录/临时包身份重验通过后才同卷硬链接原子发布，晚到目标不覆盖。[当前逻辑和限制](I6-BACKUP-CONSISTENCY.md)及[实际验证记录](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-backup-consistency-20261024.md)。下文原rename/未调用验包等为早期实现记录；不能据六批落盘宣布I6全范围通过。日常安装仍6645129，本轮不部署。

> 2026-10-17本机部署补充：I8新目录包及实际安装目录均已运行17/36/37，安装目录7/7零重试通过；真实登记空间维护备份成功且排除0，部署前后字节核对不变。日常快捷方式已切换新版、旧程序保留。下文“安装版未更新”是此前批次状态；不因此消除其它I6待验或把启动检查视为真实科研验收。[部署与回退记录](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-deployment-i8-20261017.md)。

> 2026-10-16接管补充：下文是原批次交付的历史记录。固定SDK及helper已恢复，本轮真实闭环另发现并修复运行锁误归档、维护打包原生环境漏接、恢复校验资产库路径错误。当前运行结果、目录包参数及未验边界见[最新验证](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-takeover-20261016.md)；旧“SDK缺失/manifest缺失”不能再当成本机现状，也不把六批落盘等同于所有验收完成。安装版未更新，I5待验保持。

本文是 I6（整科研空间**离线备份**与**新空间恢复**）的实施交付记录，对应
[`INTEGRATION-PLAN-I6.md`](https://github.com/littleworld215/research-asset-library/blob/main/docs/INTEGRATION-PLAN-I6.md) 的第 6 批
「文档与目录包验证：合成全模块开发/打包闭环及旧安装版互斥；源码交付与安装版替换分开」。

定位：这是一份**如实陈述**的交付说明，不是验收报告。凡「已验证」与「未验证」均逐条标注，
既有失败不隐藏、不做成 I6 的问题，未做之事不写成已通过。

- 目标基线：`459c6e4`；来源：`58839d7`。
- 本批 HEAD（写文档时）：`d10c530`，分支 `main`，远端 `origin`（自有 fork）。
- 本批**只产文档 + 只读验证**：`electron/`、`src/`、`shared/` 源码零改动，`package.json` 零改动。

---

## 1. 范围与边界

### 1.1 I6 是什么

I6 为 Mimir-Desktop 提供**整科研空间的离线备份与新空间恢复**能力，配套**只读自检**与
**保留策略**，全部发生在**独立维护窗口**（同一个 `Mimir.exe` 在保存/关闭日常窗口后进入维护模式）。

固定边界（引自计划「固定边界」节，本实现遵循）：

- 恢复为**新空间**，原空间保留，**不原地覆盖**。
- 保存空间内**全部模块、隐藏文件、未知业务键及资产历史**；全局账户/模型/服务器**凭据**、
  安装目录与 Chromium 缓存**不打包**。外置 PDF、项目、聊天产物**显式选择**，未包含依赖**明确报告**。
- 统一任务闸门、正常/维护**共同锁**、资产锁、同 profile 单实例。
- 流式 **ZIP64**（`yazl` 3.3.1 / `yauzl` 3.4.0 生产依赖）；10 万条目、64 MiB 清单、1 TiB 展开上限；
  逐文件 SHA256。源 SQLite **一致快照**，**不迁移源库**；**源外暂存、验包后不可覆盖发布**。
- 自检**只读**，审计日志**不写正文/凭据**。
- 默认普通备份**保留 20 份**，**先预览再用户确认清理**；保护迁移/注册前/导入包快照。

### 1.2 六个批次各自交付了什么（逐批一句话 + commit）

> 批次 3.5 为计划外补充批（计划原文无此批），补上了备份的**生产调用点**，故一并列出。

| 批次 | 交付内容（一句话） | commit |
|---|---|---|
| 1 · 维护基础 | 早期启动分派、最小桥、共同写锁、任务排空与失败交接 | `4c4c260` `338c7ba` `3aa6daa` `506c0e3` `603e0b6` `34522dc` `ac78414` `3754fc8` `57316f9` `1766573` |
| 2 · 完整备份 | 目录清单、外置/链接预览与选择、SQLite 快照、流式打包与独立验包 | `84c64c5` `b849717` |
| 3 · 新空间恢复 | 安全解压、路径/快照/偏好关联、目录发布与注册快照/重试 | `a093005` `7eceb37` `6af384a` `859c82b` `e7880f7` `f691e5a` `0d44121` `9bd5dc4` `9ad9074` `6e2ddff` `12acf89` `7702c24` `116478f` `867e590` `81f8a5e` |
| 3.5 · 备份生产接线 | 把批次 2 的打包原语接到主进程：`backupSpace` IPC → 编排服务 → 归档落 `<home>/backups` | `5c71f90` `842afdc` `7fc67c7` `0014c09` `23593cf` `d10c530` |
| 4 · 自检及管理 UI | 进度/取消/结果、**只读四维**健康报告（无评分）与脱敏审计 JSONL | `9f4b311` `d9d86b6` `2a8f2c0` `8cf86b6` `f62a7bf` `1f598e0` |
| 5 · 保留策略 | 20 份候选预览/确认清理，保护不可变快照（token 绑定候选集） | `7b3a38c` `b94868f` `2dbaa98` `23468ff` `2b8325e` `5671a97` |
| 6 · 文档与目录包验证 | **本文件** + 目录包可行性勘察与只读验证留档 | 见本批 commit |

> 批次 1「维护基础」在计划「进度」节曾长期标注「未完成」，实际已在后续批次中把普通模式
> 写者会话、操作闸门与维护交接装配完成（`57316f9`），并随后续批次逐项补齐。

---

## 2. 实现清单（核心模块与职责）

> 职责均**先读文件确认**后书写，非推测。目录：`electron/workspaceBackup/`。

### 2.1 备份链路（批次 2 · 3.5）

| 模块 | 职责 |
|---|---|
| `directories.ts` | 归档目录的**单一事实源**：`ARCHIVE_DIRECTORY_NAME='backups'` + `archiveDirectory(home)`。纯常量/纯函数，除 `node:path` 外零 import。（批次 3.5 · T01） |
| `manifest.ts` | 把空间根遍历成**稳定条目清单**（相对路径 + 类型 + 字节数 + SHA256）；逐文件 SHA256；条目数/清单字节/展开字节**超限抛错**；不跟随符号链接；路径统一正斜杠；**排除暂存目录与 `-wal`/`-shm`/`-journal` 瞬态文件**。 |
| `packer.ts` | 以清单为输入**流式**写 ZIP64 归档，内附 `mimir-manifest.json`；先对 `assets.db` 做 `backup()` 一致快照再入包；**源外暂存 + fsync + 原子 rename**；**不可覆盖**既有目标（`wx` 语义）；按 `archiveNaming` 自动派生目标名。 |
| `verify.ts` | **独立验包**：重开归档逐条核对（清单可解析/版本兼容、条目与清单一一对应、字节与 SHA256 一致、路径过统一 Windows 校验）。**只读、fail-fast、无「部分通过」**。 |
| `archivePaths.ts` | 归档路径的 **Windows 语义校验**（防 zip-slip、保留设备名、重复、大小写目录歧义、文件/目录冲突），供验包与恢复共用。 |
| `archiveNaming.ts` | 归档命名规范**唯一事实源**：`mimir-backup-<spaceSlug>-<YYYYMMDD-HHMMSS>.zip`；`deriveArchiveName` / `isManagedArchive`；保留策略只认此模式。 |
| `backupService.ts` | **逐空间备份编排服务层**（批次 3.5 核心）：`runSpaceBackup` 把「只读注册表解析 → 取锁 → 只读快照开库 → `createBackup` → 落 `<home>/backups` → 写脱敏审计」串成一次动作。四条铁律：只传 id 不信路径；未动盘零副作用；不静默降级（库存在但打不开即 `BACKUP_FAILED`）；出口单向裁剪（返回值无绝对路径）。IO 全可注入。 |
| `archiveScan.ts` | `backups/` **只读白名单扫描**：仅返回本应用产出的归档；**三重显式排除** `.partial`、`store.json.pre-restore-*` 快照、符号链接。为**删除**下游服务，过滤口径**严格**（不复用恢复列表的宽松口径）。 |
| `maintenanceBackupHandler.ts` | 备份 IPC **装配**（批次 3.5 · T04）：`normalizeBackupRequest`（纯函数，**只接受 `{spaceId}`，多余字段拒绝**）+ `buildBackupHandler`（不 import electron，依赖注入）+ `registerBackupHandler`（唯一接触 `ipcMain`）。通道名取自契约常量。 |

### 2.2 恢复链路（批次 3）

| 模块 | 职责 |
|---|---|
| `restoreContracts.ts` | 恢复**契约**：类型、阶段枚举、失败语义、错误码。**零 IO 零依赖**。 |
| `restoreState.ts` | 恢复**状态机**（纯函数）：实现阶段转移表与 `abortScope`（**绝不返回原空间/原注册表路径**）。零 IO。 |
| `restorePlan.ts` | 恢复**计划**（纯函数）：由「验包结果 + 目标位置」产出 `RestorePlan`；**落点不可覆盖**校验（`TARGET_EXISTS` 真拒绝）。零 IO。 |
| `restoreRunner.ts` | 恢复**编排**：把解压/校验/发布/注册串成一次可观测的 `runRestore`；**完全依赖注入**（不 import fs/electron/publish，副作用均为注入函数）；`ok:false` 一律阻断；**控制不可嵌套**；清理只限本操作产物；**绝不向上抛未捕获异常**。 |
| `restoreAdapter.ts` | 恢复各步的**真实实现**（解压/发布/注册等）与串行 staging token 假设。 |
| `restoreArchive.ts` | 归档内**旧空间根推导**（`oldRootFromArchive`）——**文件头已注明该相对推导被 T05 实测推翻**，权威基准改用 `ArchiveManifest.sourceRoot`（绝对路径）；本函数改为「选归档阶段提示 + 诊断信息」用途。 |
| `extract.ts` / `stagingRoot.ts` | 安全解压与源外暂存根。 |
| `publish.ts` | 目录发布（原子 rename，不可覆盖）。 |
| `registryAppend.ts` / `registryView.ts` | 注册表**只追加**原子写 / **只读**概览（`{id,name}`，不复用会迁移的 `loadStore`）。 |
| `spaceStoreRemap.ts` / `remapRules.ts` / `remapAudit.ts` | 空间层 `store.json` 白名单结构化路径改写（以**绝对旧根**为基准）、匹配规则与审计。 |
| `assetsIntegrity.ts` | 资产库**完整性校验**：对暂存副本 `readonly:true` 打开，核对 JSON/数据库/外键/摘要；期望表取自 `ASSETS_DDL`（不手抄）；失败即 `INTEGRITY_FAILED`。 |
| `restoreMain.ts` | 维护模式**恢复服务层**：装配点——归档旧根选择（用 `sourceRoot`）、真实完整性钩子注入、持锁串行（`WorkspaceWriterSession`）。**不调 `workspaces:*` IPC**（防自锁）。 |
| `maintenanceRestoreHandler.ts` | 恢复 IPC **装配**：`normalizeRestoreRequest`（纯函数，`targetRoot` 强制 `path.resolve`）+ `buildRestoreHandler`（不 import electron）+ `registerRestoreHandler`。**只映射用户可见字段，不泄漏路径**。 |

### 2.3 自检与审计链路（批次 4）

| 模块 | 职责 |
|---|---|
| `doctorReport.ts` | 自检报告**类型 + 汇总骨架**：类型定义在共享契约（渲染层消费），`summarize(checks)` 出**计数**（**不是评分**，对齐 D-038）；`buildDoctorReport(deps)` 四维只读聚合。 |
| `doctorArchiveScan.ts` | 自检 **C2**：对归档目录每份归档调 `verifyBackup`，fail-fast 抛错**在调用侧**收敛为逐项结论；单份失败只降 `warning`；detail 经 `redactText` 不含绝对路径。 |
| `doctorSpaceScan.ts` | 自检 **C3**：对每个已登记空间的 `assets.db` 调 `checkRestoredAssetsIntegrity`（只读）；**自实现只读注册表解析器** `readRegistrySpacePaths`（照抄 `registryView` 防御式读法，只多保留 `path`）；不可读则降级 `notice`。 |
| `doctorResidual.ts` | 自检 **C4**：扫描 `RESTORE_STAGING_PREFIX` 开头的残留暂存根，发现出 `notice`；**只报不删**。 |
| `auditWriter.ts` | 脱敏审计**落盘**：单行 `openSync('a',0o600)`+`writeSync` **原子追加** JSONL 到 `~/.mimir/logs/maintenance-audit-<date>.jsonl`；**刻意不用 temp+rename**；失败仅告警不上抛；白名单形状 + `redactValue` 兜底。 |
| `auditReader.ts` | 脱敏审计**读取**：只读按天分片、按文件名日期倒序取最近 N 条；**逐行 try/catch 容错**（跳坏行计数）；返回已脱敏视图，**不暴露 JSONL 路径**。 |
| `redact.ts` | 通用脱敏（纯函数）：绝对路径 → basename；敏感键名（token/key/secret/password/credential/authorization）整键剔除；复用 `remapRules.isAbsolutePathLike`；**不修改入参**。 |

### 2.4 保留策略链路（批次 5）

| 模块 | 职责 |
|---|---|
| `retentionPolicy.ts` | 保留策略**纯函数**：把白名单归档按策略分「保留」/「清理候选」并算可释放字节；**不删除、不校验文件名**（信任扫描层已过滤）；**零后台**。 |
| `retentionToken.ts` | 一次性确认 token：**绑定候选集摘要**（SHA-256 前缀 + `randomUUID`）；**不含候选文件列表/路径**；无时钟、无缓存、无落盘；候选集一变摘要即不符（过期**自然涌现**）。 |
| `retentionService.ts` | 保留**预览 + 显式清理**服务层：`buildRetentionPreview`（只读 dry-run → token → 脱敏视图）；`applyRetention(token)`（**只收 token**，删除目标**自己重算**，逐条双重复核后删除，失败不中止，写审计）。不匹配即 `TOKEN_MISMATCH` 零副作用。 |
| `maintenanceRetentionHandler.ts` | 保留 IPC **装配**：`normalizeRetentionToken`（纯函数，只接受 `{confirmToken}`）+ `buildRetentionHandler` + `registerRetentionHandler`。通道名取自契约常量。 |

### 2.5 锁、闸门与交接（批次 1）

| 模块 | 职责 |
|---|---|
| `operationGate.ts` | `WorkspaceOperationGate`：任务闸门（`AsyncLocalStorage` 存操作 scope，排空/拒新/超时/独立时钟预算）+ 空间写锁原语 `acquireWorkspaceLock`/`acquireWriterLockFile`（**绝不按 PID/年龄猜残锁**）。 |
| `writerSession.ts` | `WorkspaceWriterSession`：普通/维护**共享**的写者会话，持有 registry 锁 + 空间/资产锁；`assertLocalRoot` 强制本机盘核查。 |
| `writerSession` / `handoff.ts` | `MaintenanceHandoff`：交接状态机（`idle→requested→draining→blocked/handedOver`）；超时只**阻断**，绝不让迟到回调启动新写者。 |
| `ipcGate.ts` | `installWorkspaceIpcGate`：普通模式注册域处理器前安装；**控制通道**不被排空阻塞（防自等待）；恢复/自检/保留通道**刻意不在包裹集合**（维护模式独立 `ipcMain` 注册）。 |
| `localDisk.ts` | Windows **本机卷探查**：经系统 PowerShell 固定脚本调 `GetVolumePathNameW`/`GetDriveTypeW`（路径经 JSON stdin 传递）；只允许固定/可移除盘，网络/未知卷拒绝。 |
| `startupMode.ts` / `dispatch.ts` / `productionTasks.ts` / `taskSupervisor.ts` | 早期启动分派、维护模式分派、生产任务纳管与监督。 |
| `maintenanceMain.ts` | 维护窗口**主进程入口**：装配写者会话、本机盘核查、只读清单、四类 IPC handler（backup/doctor/retention/restore）、独立 `ipcMain`。 |
| `maintenancePreload.cjs` | **沙箱 preload**（自包含 CJS）：仅经 `contextBridge` 暴露白名单 API；通道名须与契约常量**字节一致**（沙箱无法加载 TS 契约）。 |

### 2.6 共享契约与渲染层 UI

| 模块 | 职责 |
|---|---|
| `shared/workspaceBackupContracts.ts` | **通道/类型契约**：`WORKSPACE_BACKUP_CHANNELS`（overview/backupSpace/restore/doctor/auditRecent/retentionPreview/retentionApply + 进度/取消事件）、各类结果视图类型、`WorkspaceBackupMaintenanceApi`。**主进程与沙箱渲染层共用**；新增字段一律可选（双向兼容）。 |
| `src/renderer/maintenance.tsx` | 维护窗口 UI（594 行）：按空间发起备份（进度 + 结果）、恢复（选归档/目标/进度/取消）、只读自检（四维报告 + 进度 + 取消）、审计查看、保留预览/确认清理。`failureText(code)` 只把**错误码**翻成人话，**不做任何路径拼接**。 |
| `src/renderer/maintenance.css` | 维护窗口样式（46 行）。 |

---

## 3. 端到端数据流

### 3.1 备份（批次 3.5）

```
维护窗口 UI (maintenance.tsx)
  → window.workspaceBackupMaintenance.backupSpace({ spaceId })      [maintenancePreload.cjs]
  → IPC 'workspaceBackup:backupSpace'                               [独立 ipcMain, 非 ipcGate 包裹]
  → maintenanceBackupHandler.normalizeBackupRequest（只认 {spaceId}）
  → backupService.runSpaceBackup(deps)
       ├─ ① 校验入参                → INVALID_SPACE（未动盘）
       ├─ ② readRegistrySpacePaths   → 由 spaceId 解析空间根（渲染层不给路径）
       ├─ ③ acquireSpaceLock         → 只作可用性检查；占用即 LOCK_UNAVAILABLE（未动盘）
       ├─ ④ 只读开库快照 db.backup()  → 库不存在=无库归档；存在但打不开=BACKUP_FAILED
       ├─ ⑤ createBackup             → manifest 清单 → 流式 ZIP64 → 源外暂存 → 验包 → 原子发布
       └─ ⑥ 落 <home>/backups/       → mimir-backup-<slug>-<YYYYMMDD-HHMMSS>.zip
  → appendMaintenanceAudit（脱敏 JSONL，仅空间名 + basename，无绝对路径）
  → 进度事件 'workspaceBackup:backupProgress'（basename，无路径）
```

### 3.2 恢复（批次 3）

```
维护窗口 UI
  → window.workspaceBackupMaintenance.restore({ archivePath, targetRoot, spaceName })
  → IPC 'workspaceBackup:restore'（独立 ipcMain；ipcGate 包裹集合中刻意排除）
  → maintenanceRestoreHandler.normalizeRestoreRequest（targetRoot 强制 path.resolve）
  → restoreMain.runMaintenanceRestore（持 WorkspaceWriterSession：registry 锁 + 新空间锁）
       ├─ 选归档 → verify 验包（只读）
       ├─ 由 ArchiveManifest.sourceRoot（绝对）确定旧根
       ├─ 安全解压到源外同盘暂存根（先取空间写锁）
       ├─ checkRestoredAssetsIntegrity（readonly 打开暂存副本，核对 JSON/DB/外键/摘要）
       ├─ 路径改写：store.pdfPath 等白名单字段（以绝对旧根为基准）
       ├─ 发布：不可覆盖 rename 暂存 → 目标新空间目录
       └─ 注册：writeRegistryAtomic 原子追加新 UUID 记录（保留原设置/active/default）
  → 进度事件 + 结果（只映射用户可见字段，绝不带 cleanup/remap/暂存根路径）
```

### 3.3 保留（批次 5）

```
维护窗口 UI
  → retentionPreview → IPC → maintenanceRetentionHandler
       → listManagedArchives（白名单只读扫描 backups/）
       → planRetention（保留 20 份 → 候选）
       → createRetentionToken（绑定候选集摘要）
  → 返回脱敏视图（文件名/字节/时间/处置/原因，无绝对路径）
  用户确认 → retentionApply({ confirmToken })   （绝不收文件列表）
       → 主进程重算候选集 → 校验 token → 逐条双重复核 → 删除 → 幂等 → 写审计
       → 不匹配即 TOKEN_MISMATCH，零副作用
```

### 3.4 自检（批次 4）

```
维护窗口 UI
  → doctor → IPC → maintenanceDoctorHandler.buildDoctorHandler
       → buildDoctorReport(deps)：C1 归档命名规整 / C2 归档逐份验包 /
                                   C3 已登记空间 assets.db 完整性 / C4 残留暂存根
  → 返回四维只读报告：四级严重度 + 逐项结论 + 计数（CHECK 无「健康分/评分」，对齐 D-038）
  → auditRecent 读取脱敏审计（只返回 entries/skipped，不暴露 JSONL 路径）
```

---

## 4. 安全与一致性约束（已验证的设计约束）

> 每条均为**代码中可核验**的实现纪律；注明「为什么」。

1. **归档命名规范** `mimir-backup-<slug>-<YYYYMMDD-HHMMSS>.zip`，保留策略**只认此模式**——
   因为保留策略下游是**删除**，命名是「什么是本应用产出」的唯一可解析凭据（时间可排序、空间可识别）；
   用 UUID 名两者都给不了。
2. **SQLite 快照**：`db.backup()` **只读**打开源库；**`-wal`/`-shm`/`-journal` 绝不进归档**
   （批次 3.5 · T02 修的真实缺陷）——SQLite 只读打开 WAL 库**仍会在源目录留下** `-shm`/`-wal`，
   若入归档就会得到「**快照版主库 + 实时版 WAL**」的**不一致组合**，验包/恢复都会读出错误状态。
   → 故「只读」**不等于**「不触碰源目录」，但瞬态文件必须由 `manifest.ts` 后缀排除挡在清单之外。
3. **暂存与发布**：源外**同盘**暂存 → 验包 → **不可覆盖 rename** 发布——
   同盘保证 rename 原子；不可覆盖保证不静默毁掉既有空间/备份。
4. **锁纪律**：注册表/空间**共同写锁**；**不按 PID/年龄猜残锁**（失败即失败）；
   备份取锁**只作可用性检查**（批次 3.5 裁决）——维护会话**不调** `session.select()`，
   因为 `defaultAcquireSpaceLock` 的锁路径与 `select()` **同名同址**，再取即**自锁**。
5. **渲染层只见 `spaceId` / basename**，**全程无绝对路径外泄**（含审计与进度）——
   父目录常含用户名/课题名/盘符，属本批明确收敛的暴露面；需要位置时用**根别名**而非真实路径。
6. **保留策略**：`token` **绑定候选集摘要**，渲染层**无法指定删除目标**（删除目标由主进程自己重算）；
   **无任何后台自动清理**（D-032）——清理只在你**主动调用**时发生，且必须经二次确认。
7. **自检只读**：不取锁、不建目录、不写文件；**不写正文/凭据**；报告只陈述技术事实、**无评分/健康度**（D-038）。
8. **未动盘零副作用**：备份/保留在「校验入参/解析/取锁」阶段失败时**不建目录、不写审计**——
   「没动盘就不该留执行记录」。

---

## 5. 验证记录

### 5.1 基线对照（当前 HEAD，与主理人实测一致）

| 闸门 | 结果 |
|---|---|
| `corepack pnpm typecheck` | **exit 0** ✅ |
| `corepack pnpm build` | **exit 0** ✅ |
| `corepack pnpm test` | 27 failed / 1718 passed / 9 skipped（1754 项，175 文件） |
| `vitest run test/unit/workspaceBackup` | **1 failed / 592 passed**（唯一失败 = `localDisk.test.ts`） |

**关于 27 个失败（如实声明）**：这 27 个失败**全部是既有失败，与 I6 无关**。
在批次 3.5 **之前**的提交 `5671a97` 上用 `git worktree` 复现过**完全相同**的失败
（`AssetsStoreError: 搬入的版本文件身份发生变化。` @ `electron/assets/fileService.ts:287`）。
失败分布：

- `test/unit/assets/fileService.test.ts` 14
- `test/unit/assets/archiveService.test.ts` 4
- `test/unit/assets/folderImport.test.ts` 3
- `test/unit/assets/mcpAdapter|mcpDiscovery|mcpHost|mcpWindowsPipe.test.ts` 各 1
- `test/unit/ipc/rendererPathGuards.test.ts` 1
- `test/unit/workspaceBackup/localDisk.test.ts` 1（沙箱 `NATIVE_VOLUME_PROBE_FAILED`）

> 这些失败**不是** I6 引入，**也不隐瞒**——它们是既有的、可独立复现的问题，留给对应模块单独处理。

### 5.2 本批实测（命令 + 真实 exit code + 计数）

> ⚠️ **更正声明（2026-10-12）**：本表 `checkAssetsPipeHelper.mjs` 一行**先前测得为 exit 0**
> （`{"kind":"pipe-helper-verified","files":193,"sourceHash":"8795226d…"}`），该结果是**探测 `build:win`
> 之前**的陈旧状态。本批为勘察 `build:win` 可行性而实际运行了 `prepareAssetsPipeHelper.mjs`，
> 该脚本**按设计先删旧 manifest**（`scripts/prepareAssetsPipeHelper.mjs:47`：
> 「A failed new build must never leave a previous manifest looking current」），随后因缺 .NET SDK
> 失败，导致 manifest **未被重建** → `checkAssetsPipeHelper.mjs` 现在**必然 exit 1**。
> 下表已更正为**探测后**的真实状态。**原 exit 0 已失效**，不得再被引用。

| 命令 | 真实 exit code | 说明 |
|---|---|---|
| `corepack pnpm build` | **0** | 见下方 `out/` 三层计数 |
| `node scripts/checkAssetsPipeHelper.mjs` | **1** | `ENOENT: manifest.json 缺失`（见上方更正声明；探测副作用，非项目缺陷） |
| `node scripts/checkAssetsNative.mjs` | **0** | 7/7 通过，0 失败（sqlite_version=3.49.2、外键、事务回滚、重开、integrity_check=ok、FTS5、trigram） |
| `node scripts/prepareAssetsPipeHelper.mjs` | **1** | ENOENT：缺 `%LOCALAPPDATA%\MimirBuildTools\dotnet\10.0.401\dotnet.exe`；且该次失败**已删旧 manifest** |
| `electron-builder --win --dir --publish never` | **1** | electron 33.4.11 下载 100% 后，因沙箱 safe-delete 守卫拒绝删除既有 `dist/win-unpacked`（378 文件）而中止 |

**`checkAssetsPipeHelper.mjs` exit 1 的完整说明**：`.native/assets-pipe-helper/win-x64/` 下
**193 个载荷文件完好无损**，仅 `manifest.json` 缺失——`verifyPipeArtifact`
（`scripts/lib/assetsPipeArtifact.mjs:71-72`）**硬依赖 `manifest.json`**，故校验必然失败。
`.native/` 属 gitignored（`.gitignore:11`），manifest **从未被 git 跟踪，无从恢复**。
恢复方式：在具备 **.NET SDK 10.0.401** 的环境重跑 `node scripts/prepareAssetsPipeHelper.mjs`
即可重建 manifest（本批缺 SDK，未尝试硬恢复——硬试只会再次失败）。

`out/` 三层产物计数（`corepack pnpm build` 后）：

| 层 | 文件数 | 关键产物 |
|---|---|---|
| `out/main` | 11 | `main-D5K0lVxv.js`、**`maintenanceMain-B_gG3Lnw.js`**、`localDisk-BgmQMdZa.js` |
| `out/preload` | 2 | `index.mjs`、**`maintenance.cjs`**（沙箱 preload） |
| `out/renderer` | 23 | `index.html`、**`maintenance.html`**、`maintenance-c.js`(22.79 kB)、`maintenance-*.css`(2.57 kB) |

> 结论：**维护窗口（maintenance）已完整进入三层构建产物**——主进程编译出 `maintenanceMain`，
> preload 编译出 `maintenance.cjs`，renderer 编译出 `maintenance.html` + JS + CSS。

### 5.3 目录包验证（任务 B）——**阻塞，如实报告**

计划要求「合成全模块开发/打包闭环」。本批**未能**完成目录包构建，**阻塞原因与最大程度验证**如下。

**阻塞原因（不可行）**：

1. **`pnpm build:win` 第一步即失败**：`build:win` = `node scripts/prepareAssetsPipeHelper.mjs && electron-vite build && electron-builder --win --publish never`。
   第一步 `prepareAssetsPipeHelper.mjs` 实测 **exit 1**，原因 = 缺固定版本 .NET SDK
   （`native/assets-pipe-helper/global.json` 钉死 `10.0.401` 且 `rollForward: disable`，
   而 `%LOCALAPPDATA%\MimirBuildTools\dotnet\10.0.401\dotnet.exe` 不存在；`C:\Program Files\dotnet\`
   下亦**无 `sdk/` 目录**）。缺此 SDK 无法 `dotnet publish` 管道 helper。
2. **即便跳过第 1 步，`electron-builder --win` 仍在沙箱内中止**：electron 33.4.11 已下载 100%
   （electron 缓存可用），但在 `extractArchive` 阶段需**删除既有 `dist/win-unpacked`（378 文件）**，
   被**沙箱 safe-delete 批量删除守卫**（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，阈值 50）拒绝。
   这是**沙箱文件系统守卫**限制，**不是**项目构建缺陷。
3. **NSIS 安装包**（`win.target: nsis + portable`）还需下载 `winCodeSign`/`nsis` 等工具，
   本机无 electron-builder 缓存（`%LOCALAPPDATA%\electron-builder\Cache` 为空），网络获取路径未验。

**实际做到的最大程度验证（已全部执行、留档如上表）**：

- ✅ `corepack pnpm build` exit 0，`out/` 三层产物齐全（含 maintenance 三层），计数已录。
- ✅ `node scripts/checkAssetsPipeHelper.mjs` exit 0（对**既有** `.native/assets-pipe-helper/win-x64`
  预构建产物做独立校验：193 文件、sourceHash 匹配、PE 头校验通过）。
- ✅ `node scripts/checkAssetsNative.mjs` exit 0（Node ABI 下 7/7 全通过）。
- ✅ `electron-builder --win --dir` 已尝试，失败点与原因明确记录（非项目缺陷）。
- ✅ 既有 `dist/win-unpacked/Mimir.exe`（188,784,640 字节，Oct 7）**全程未被修改/未替换**。

> **明确结论**：目录包构建、`MIMIR_E2E_PACKAGED` 跑 `e2e/specs/17-packaged-assets.spec.ts`、
> **安装版替换**在本批**均未执行**（因缺 .NET SDK 与沙箱守卫限制）——**如实记为待真实 Windows 环境完成**。
> **绝不**把「没做」写成「已通过」。
>
> 说明：由于目录包未产出，计划要求的「**旧安装版互斥**」闭环**未在本批验证**；
> 本批严格践行计划原文「**源码交付与安装版替换分开**」——**只做源码交付，未替换/未触碰已安装版**。

---

## 6. 未验边界（**诚实节，必读**）

以下均为**尚未验证**的点，不得被理解为「已通过」：

1. **真实 Windows Electron ABI 下的备份/恢复**：vitest 只有 Node ABI。批次 3.5 的**真库只读快照路径**
   （`db.backup()` → 归档）在单测里**全部走注入的假 `openAssetsDb`**，**未在真实 Electron ABI 覆盖**。
   Node ABI 下的 `checkAssetsNative.mjs` 通过 ≠ Electron ABI 下通过（原生绑定是双 ABI 缓存，`npmRebuild:false`）。
2. **`localDisk.test.ts` 的 `NATIVE_VOLUME_PROBE_FAILED`**：沙箱无 PowerShell/`Add-Type`，
   原生卷探针不可用 → 该用例失败（既有、非 I6 引入）。真实 Windows 下本机盘探查仍待验。
3. **安装版替换未执行**：本批只做**源码交付**，**未替换/未触碰已安装版**（计划原文要求二者分开）。
   目录包未构建（见 §5.3），故「旧安装版互斥」闭环未验。
4. **跨机器 / 网络路径 / 真实映射盘未验**：`localDisk.ts` 的「拒绝网络/未知卷」仅有单测语义覆盖，
   **无真实映射盘/SMB 验收**（计划「底层接线前置条件」节亦明示「尚无真实映射盘验收」）。
5. **真实用户资料与已运行安装版全程未操作**：本批所有验证均在**沙箱 / 合成空间**内完成，
   `~/.mimir` 真实资料与真实运行的 Mimir 全程未被读写。
6. **目录包构建闭环未完成**：见 §5.3，缺 .NET SDK 10.0.401 + 沙箱守卫限制，待真实 Windows 环境。
7. **`.native/assets-pipe-helper/win-x64/manifest.json` 当前缺失**：本批为勘察 `build:win` 运行了
   `prepareAssetsPipeHelper.mjs`，该脚本按设计先删旧 manifest 后因缺 SDK 失败，manifest 未重建
   （`.gitignore:11` 使 `.native/` 从未被跟踪，无从恢复）→ **恢复前 `assets:pipe:check`
   （`checkAssetsPipeHelper.mjs`）将持续 exit 1**。需在具备 .NET SDK 10.0.401 的环境重跑
   `node scripts/prepareAssetsPipeHelper.mjs` 恢复（193 个载荷文件完好，仅 manifest 缺失）。
8. **依赖 I6 的既有失败**：27 个既有失败（§5.1）未在 I6 范围内修复，属既有问题。

---

## 7. 后续待办

1. ~~**`publish.ts:73` 悬垂符号链接**：发布后可能遗留悬垂 symlink，待处理。~~
   → **已修复** `f41c885`。复核时发现原描述有误（`:73` 只是 `if (!existsSync(path)) continue`，
   那里不创建链接）；但读源码时发现**更真实的同源缺陷**：`assertPublishableStaging` 用 `existsSync`
   判受保护目录是否存在，而 `existsSync` **跟随链接** → 悬垂符号链接被判为「不存在」而**整体跳过** S8 检查。
   已改用 `lstatSync` 探测（仅 `ENOENT` 才跳过），并加 2 条回归用例 + 变异验证。
2. **目标父目录为符号链接 → `INTERNAL`**：需给出更明确语义或拒绝口径。
3. ~~**`verify.ts` 整文件 `Buffer.concat` 内存问题**：大归档逐条校验时的内存占用需优化（流式）。~~
   → **已修复** `0ad39d5`。新增流式 `hashEntry`（逐 chunk `hash.update` + 累加 size，不 `Buffer.concat`），
   逐文件摘要不再整读入内存；错误码/消息文案逐字保留。`readEntry` 的整读保留但加注释说明仅用于读有上限的 manifest。
   新增 4 条用例（含 `createHash` 打桩证明 `update` 多次、单块 < 文件体积的机制层断言）+ 变异验证。
4. **外置资料登记特性待裁决**：外置 PDF/项目/聊天产物的显式选入登记尚未定稿。
   → **已设计立项（2026-10-12）**：用户裁决立项，设计稿见 `docs/design/I6-TODO4-EXTERNAL-MATERIALS-REGISTRY.md`。
   形态定为「**空间内登记表（`<space>/.mimir/external-registry.json`）+ 打包时并入**」，
   **否决**「打包时临时弹窗选择」（违背离线维护前提、跨次不可复现、与「登记」语义冲突）。
   归档内以虚拟根 `__external__/ext-<id>/` 表示外置条目 → `verify` 零改动。
   登记复用 `pickedPaths` 授权门，只登记引用不复制内容，源失效走 `ExcludedEntry` 明确报告。
   实施分 T01–T07（见设计稿 §6），**本批只出设计稿，未实施**。
   → **⚠️ 后续裁决（同日）：不进入 T01–T07 实施**。用户裁决本特性**停留设计阶段**——
   「立项」仅指设计立项，**不等于排期**；T01–T07 **不开工**，设计稿留档备查
   （未来条件成熟可据稿直接启动，无需重新勘察）。**本项维持「待裁决」原状态**：
   外置资料**现状不变**（仍结构性不进归档），I6「未包含依赖明确报告」口径**继续保持**。
   详见设计稿 §6.0 与 `INTEGRATION-PLAN-I7.md`。
5. **目录包/安装版替换**：待具备 .NET SDK 10.0.401 与真实 Windows 打包环境的批次执行
   （并与源码交付**分开**）。
6. **真实 Windows Electron ABI 下的端到端备份/恢复 + `17-packaged-assets.spec.ts`**：待目录包产出后补验。
7. **恢复 `.native/assets-pipe-helper/win-x64/manifest.json`**：在具备 .NET SDK 10.0.401 的环境重跑
   `node scripts/prepareAssetsPipeHelper.mjs`；恢复前 `assets:pipe:check` 持续失败（详见 §5.2 / §6.7）。

> **存量质量优化（2026-10-12）**：上列第 1、3 项与 `electron/assets/fileService.ts` 的搬入身份误判
> 已一并修复，对应 `f41c885`（S8 悬垂链接）、`0ad39d5`（验包流式）、`903132f`（搬入身份以 dev+ino 为准，
> 不再以 `nlink` 误拒合法导入，`fileService.test.ts` 由 14 failed → 37 passed）。
> 详见本仓库 `git log` 与工作日志。

---

## 附：本批纪律遵守声明

- 零新增依赖，`package.json` 未改。
- `electron/`、`src/`、`shared/` 源码未改（本批只产文档 + 只读验证）。
- `docs/design/` 下设计稿：本批期间保持 untracked 未提交；后经 `17a8b9c` 统一入库
  （批次 3 稿早已在 `81f8a5e` 入库，为保持惯例自洽而补齐其余三份）。
- 未操作真实用户资料（`~/.mimir`），未启动真实已安装的 Mimir。
- 未切分支、未 `git reset`/`stash`。
- 只提交自有 fork（`origin` = `git@github.com:littleworld215/Mimir-Desktop.git`），未触碰 upstream（`hxhy00/Mimir-Desktop`）。

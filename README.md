# Mimir Desktop

2026-10-19 I9小修复与本机部署完成：素材包的问题选项、默认值与失效回退统一限定所属课题；已打开的选卡窗口固定问题身份。回归先RED（2失败/3通过）再GREEN（5/5），完整类型/原始测试/构建均exit0：1948通过、9既有跳过（211文件1957项）。开发Electron13/13、实际安装目录14/14，均零测试重试。新包与实际运行目录审计通过，564文件逐一SHA256一致。配置/用户profile/整空间已备份，原I8及更旧目录保留；两处日常快捷方式已切换到`%LOCALAPPDATA%/Programs/Mimir-Research-Releases/20261019-i9-reviewed-01/`，已从Windows桌面入口实际启动。真实文献及I5/I6其它待验保持；自验不称独立运行QA。[部署与回退记录](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-deployment-i9-20261019.md)。

2026-10-18 I9完成Windows x64源码与隔离目录包交付验证：问题分组/比较、固定版本写作素材、差异更新、Markdown导出、健康/恢复及共用退出保护。最终类型检查/原始测试/构建均exit0：1945通过、9既有跳过（211文件1954项）；开发Electron13/13、新目录包14/14，均零重试。包审计26,075项及193辅助文件通过。一次非作者静态复核后集中修复并重新完整验证，不称独立运行QA。现有I8安装版未替换，真实课题及I5/I6原待验不变；全部项目范围的问题默认选项已知限制见下文。

下方2026-10-18及更早内容按批次保留历史状态；当前状态以本页2026-10-19及[最新部署记录](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-deployment-i9-20261019.md)为准。[前一轮I9验证报告](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-i9-20261018.md)保留当时结果。

2026-10-18 I9第五批：文献库新增“研究问题与写作素材”入口，支持分组比较、跨页选卡、素材排序与固定历史、差异更新和完整Markdown预览。复用未保存保护，冲突保留输入；启动失败可重试，新建/删除课题不能绕过保护。类型检查与原始全量1931通过、9既有跳过（210文件1940项）exit0；真实Electron、整空间恢复和新目录包待Task6，当前安装版保持I8。

2026-10-18 I9第四批：13条可信研究接口、固定preload桥、原生授权导出及实际维护/退出任务等待已接；来源观察或空间在保存窗口期间变化会拒绝旧预览，wx拒绝覆盖。完整三闸门exit0（1922通过、9既有跳过；203文件1931项），尚无研究界面及真实桌面/恢复/包内验收，不改变I8安装版。

2026-10-18 I9第三批底层：素材包保存固定问题/证据版本、保留修订历史，经完整差异预览显式更新所选引用；已提供按拟写小节整理的完整Markdown序列化。研究域42项回归、类型/原始全量/构建exit0（1911通过、9既有跳过；200文件1920项）。原生导出授权、研究业务接口/UI及恢复/包内验证仍待，不改变安装版。

2026-10-18 I9第二批底层：问题组新增/修订/归档、保留失联引用、完整正文筛选后按50卡分页已实现；同一比较使用一致来源观察，来源移除会计入异常。研究域32项回归及目标完整三闸门通过（1901通过、9既有跳过；197文件1910项）。尚无研究组织业务IPC/UI或素材服务，安装版保持I8。

2026-10-18 I9第一批底层：研究问题/写作素材的数据合同与原子保存已实现，含只追加历史、容量和路径保护；新增21项专项、完整类型检查/原始全量/构建通过（1890通过、9既有跳过）。研究组织服务、界面和恢复验收仍待后续批次，当前安装版保持I8。[计划与当前进度](https://github.com/littleworld215/research-asset-library/blob/main/docs/superpowers/plans/2026-10-18-research-question-material-pack.md)。

2026-10-17 本机部署更新：原桌面和开始菜单的“Mimir 科研工作台”已指向 `%LOCALAPPDATA%/Programs/Mimir-Research-Releases/20261017-i8-6f4835f/`，旧 `%LOCALAPPDATA%/Programs/Mimir-Research/` 完整保留。配置与科研空间已备份，安装目录7/7隔离回归、原profile启动与新入口核对通过；未整理真实文献或触发模型。使用原快捷方式即可打开新版，真实课题待用户指定。[部署及回退](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-deployment-i8-20261017.md)。下方各批“安装版未替换”保留当时状态。

2026-10-17 I8 收尾：文献证据卡、修订历史、PDF来源核对、比较矩阵和Markdown/CSV/全历史JSON导出已实现。最终完整门1869通过、9既有跳过（192文件1878项），类型/构建exit0；开发Electron13/13零重试通过。新目录包审计及包内7/7零重试通过；安装版未替换，I5/I6原待验不变。[实际证据与边界](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-evidence-20261017.md)。

## 研究问题与写作素材（I9 源码能力）

在「文献库」选择课题，再打开「研究问题与写作素材」。原阅读笔记和证据比较矩阵继续保留。

1. **按问题整理**：新建问题，填写具体问题及说明，选择已有证据。关键词、人工关系和分页不会清空已选集合；点击「应用选择」后仍需「保存问题」。例如把支持和反对同一判断的卡放入一组，比较方法、材料、发现及局限。
2. **组织写作素材**：切换「写作素材」，从问题组选卡，填写拟写小节和个人说明；用上移/下移调整顺序，保存时固定当时的问题与证据版本。同一卡可以出现在不同问题组，条目数与唯一卡数分别统计。
3. **审阅后更新**：证据有新版本仅提示，不替换旧正文。点击「更新引用」，明确勾选条目、预览完整旧新内容，确认后只推进所选引用。历史版本始终只读，旧素材仍可预览导出。
4. **预览并导出**：「导出素材」展示完整Markdown，含文献、原文摘录、判断、页码、局限、个人说明及异常。原生保存窗口只创建新文件；已有目标或预览期间资料变化会拒绝保存。草稿和相反证据不会被自动删除。
5. **保存与离开**：失败/冲突保留输入，不自动重载覆盖。重新加载详情前先保存或取消；列表刷新不会改变编辑的版本基线。支持Ctrl/Cmd+Enter保存、多行换行及输入法保护；切课题、模块和关闭沿用统一未保存提示。

数据位于当前空间的 `.mimir/library/research.json`，只存组织信息及引用，正文仍在 `evidence.json`。问题与素材修订只追加，不物理删除；归档仍占容量。首版上限200个问题组、100个素材包、每版本500引用、全历史16MiB，超限拒绝保存而不截断；大规模管理与自动压缩尚未实现。

整空间备份保留两文件及全部历史。只读自检分别报告结构/格式与失联引用；未找到文件不能证明从未使用，如预期已有资料应核对备份。损坏或较新格式的研究资料会在恢复发布前阻断；失联引用保留并警告，不自动修复。备份原字节成功不代表科研内容或引用健康。

问题选项与默认值均限定素材包所属课题的非归档问题。列表刷新保留有效选择；当前选择失效时回退，无候选则禁止选入。已打开的选卡窗口固定问题身份，防止异步刷新改变证据归属；服务端继续复核跨课题引用，已有固定内容保留。

当前仅人工整理与Markdown导出，不自动生成科研结论，不新增模型调用、Agent/MCP写工具、PDF摘录或外置文件登记。源码、开发桌面验证、新目录包与实际安装部署分别登记；现有安装版不会自动更新。Windows x64合成资料验证不代替真实课题使用验收。

## 文献证据工作流

在“文献库”的条目中点击“证据卡”，人工摘录原文、填写比较字段和个人判断；同篇可建多卡并保留相反证据。显式保存追加修订，历史只读，归档不删除。旧阅读笔记保持独立，无PDF也可以保存草稿。

有当前空间受管PDF时点击“检查来源”，确认内容与页码后使用“我已核对原文与页码”；来源变化会提示且不会自动重绑。打开原文后按物理页码人工定位，检查结果只代表所显示的时间点。

点击“证据比较矩阵”筛选、比较并打开对应卡片。“导出证据”作用于完整筛选范围；Markdown/CSV导出当前版本，JSON保留选中卡全部历史，选择新文件保存，不覆盖已有目标。JSON首版不提供覆盖导入；证据与PDF随已有整空间备份/恢复为新空间流程保存。

首版限制为5000卡及完整历史32MiB；没有自动模型抽取、OCR、外置PDF绑定或精准跳页。下面各日期条目为实施历史。

2026-10-17 I8第五批：源码已接派生证据矩阵、50篇分页/完整内容筛选、失联快照和Markdown/CSV/全历史JSON导出；八通道齐全，导出预览与保存使用内容指纹，原生选择后重验范围，wx拒绝覆盖。25项专项与类型检查通过，完整三闸门exit0（1864通过、9既有跳过；192文件1873项），旧文献+证据/矩阵导出Electron9/9零重试通过；安装版与I5/I6待验保持。

2026-10-17 I8第四批：新增文献证据入口、原文/比较/个人判断编辑、只读历史和来源状态，保留旧笔记；模块/项目/空间/窗口离开串接守卫，失败保留输入。11项界面及原资产守卫专项通过，类型检查通过，完整三闸门exit0（1845通过、9既有跳过；189文件1854项），旧文献+证据桌面8/8零重试通过；矩阵和导出未接，安装版未更新。

2026-10-17 I8第三批：七条受控证据接口、可信主窗口主框架、固定空间任务寿命与维护停止已接线；PDF协议共享受管解析器。证据域及原有IPC闸门58项专项通过，完整三闸门exit0（1837通过、9既有跳过；185文件1846项），旧文献Electron回归7/7零重试通过。UI未接，矩阵完整筛选与导出在后续批次，不表示安装版可用。

2026-10-17 I8第二批：已实现受管PDF流式SHA256、文件身份前后核对、人工确认绑定及来源异常状态；14项来源专项通过，完整三闸门exit0（1827通过、9既有跳过；182文件、1836项）。当前没有UI入口，不读取外置PDF、不自动重绑，不宣称精准页码跳转。

2026-10-17 I8证据卡第一批：独立`.mimir/library/evidence.json`支持严格人工字段、5000卡/32MiB全历史上限、原子保存、冲突检查、追加修订与归档，保留失联文献快照和旧阅读笔记。底层专项29/29与类型检查已通过，完整三闸门exit0（1813通过、9既有跳过；180文件、1822项）；当前UI尚未接入，来源核对、矩阵、导出及真实桌面/恢复验证未完成，安装版未更新。

2026-10-17 备份完整性：普通 `-wal/-shm/-journal` 文件及目录正常保留，只排除受管资产库旁文件；Windows 清单与 ZIP 共用快照路径比较，实际 `ASSETS.DB` 也包含已提交 WAL。此前归档若已遗漏资料须重新备份，恢复无法重建缺失字节。回归、目录包与未验边界见[本轮证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-backup-exclusions-20261017.md)，安装版未替换，I5待验不变。

2026-10-16 接管修复：I6/I7 的源码交付已推进，以下 10 月 10 日进展是历史状态。维护备份现排除精确的运行写锁路径，避免恢复时与新锁冲突；同名用户资料及锁备份仍保留。维护服务显式使用真实打包环境解析原生绑定，恢复校验实际资产库路径并拒绝缺表副本。新增真实 SQLite/WAL、历史正文、草稿、隐藏文件与 Unicode 路径的维护 IPC 闭环。验证结果和未验边界见[本轮记录](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-takeover-20261016.md)；不代表安装版已更新或 I5 已终验。

2026-10-10 I6资产AI续项：润色、重构与标签建议保留及时取消/超时反馈；底层模型与同步草稿保存/标签解析持续受监督至实际完成，晚到结果拒绝。窗口四名额和销毁监听跟随真实完成，取消不提前释放名额。主进程维护停止接口尚未装配；慢开库及普通采纳/同步IPC仍待统一生命周期接线，第一批/I6未完成，第二至六批未实现，I5待验不变。见[本轮证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-i6-assets-ai-20261010.md)。

2026-10-10 I6直接图执行续项：直接评分对话现绑定监督器；原工具函数和文件后端实际结束前不释放任务，停止信号仅传入原函数及模型传输，避免SDK提前取消race。正常网络重试保留，根结束时取消未消费正文。流式入口未安装本轮执行范围，普通main完整锁/闸门及严格退出未装配，资产AI、其它下载和受管子进程待纳管；第一批/I6未完成，第二至六批未实现，I5待验不变。见[本轮证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-i6-execution-20261010.md)。

2026-10-10 I6独立AI请求续项：历史压缩与能力域生成入口已接入同一任务监督器；停止拒绝新请求、传递取消并等待实际返回，空间切换或取消后的晚到结果不能返回成功。原有压缩文本/生成草稿契约保留。普通main整体保护及严格退出仍未装配，资产AI与其它生产入口生命周期继续待审计，备份恢复不可用，安装版未更新。见[本轮证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-i6-independent-ai-20261010.md)。

2026-10-10 I6 Agent续项：对话整轮在接受时固定空间，正文结束后工具/委派/图最终状态继续受跟踪；立即停止不遗漏未启动轮次，非取消流错误不能冒充成功。普通main退出和整体锁/闸门尚未装配，独立AI入口/其它下载及受管子进程待纳管，备份恢复不可用。见[本轮记录](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-i6-agent-20261010.md)，安装版未更新。

2026-10-10 I6后台任务续项：会议缓存刷新与独立arXiv PDF下载现按接受时空间跟踪到实际结束，切换或取消后拒绝发布，旧文件保留。停止接口已提供，但普通main退出及完整空间闸门尚未装配；Agent、其它下载和子进程继续待纳管。备份恢复不可用，安装版未更新，[本轮证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-i6-producers-20261010.md)区分自验与静态复核。

2026-10-10 I6续项：新增可安装的固定任务上下文与串行空间控制协议，任务绑定空间ID/代际/根；迟到读写与未跟踪写入拒绝，控制先排空、失败/超时保持阻断。普通main尚未装配，Agent/下载/PTY等后台纳管及维护交接仍待，备份恢复不可用。[本轮验证](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-i6-context-control-20261010.md)与上一轮初始化结果分开登记。

2026-10-10 受保护初始化增量：`loadStore(session)` 可在已有、全新及旧资料迁移场景先占注册表/空间锁，初始化失败阻断；新根先查本机磁盘再建目录，受保护迁移保留旧目录。普通main仍未调用此入口，任务排空/失败交接未完成，不能视为备份恢复已可用。[本轮证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-i6-protected-startup-20261010.md)另记，不覆盖旧轮结果。

2026-10-10 I6增量：store已提供可安装的空间切换锁保护，指针保存失败还原缓存/代际，锁清理失败阻断后续写入；安装时核对注册表与空间根。普通启动尚未自动装配，任务排空仍待接线，目前维护窗口只读，备份恢复不可用。

I6整科研空间离线备份/新空间恢复实施中。源码增加显式启动的只读维护窗口，仅展示已登记空间名称；尚不能备份或恢复，也没有设置入口。正常任务排空与共同锁接线仍待完成，第一批及I6未验收。安装版未更新，I5待验不变；[批准计划与当前进度](https://github.com/littleworld215/research-asset-library/blob/main/docs/INTEGRATION-PLAN-I6.md)区分实施、静态复核及真实验收。

2026-10-09 资产管理首批优化：搜索按去首尾空白后的 200 Unicode 码点校验，超限输入保留并提示，不截断 emoji。快速取用输入后立即 Enter 会等待匹配查询，查询失败、继续输入、切换范围或输入法组合开始后不打开旧详情。源码已更新，已有安装版尚未替换；I6完整备份/恢复与I7界面优化仍未实现。完整状态与证据见[优化跟踪](https://github.com/littleworld215/research-asset-library/blob/main/docs/ASSETS-OPTIMIZATION.md)。

人工入口新增可选单步模式（`MIMIR_MANUAL_STEPWISE=1`）：每次说明当前动作后才开始一个请求，保留连续模式和真实批准规则。见[操作说明](e2e/manual/README.md)；步骤开始文件不代表授权，真人验收仍须另行记录。

2026-10-09 人工验收入口：新增显式 Windows 原生批准流程，临时空间与合成资料、真实按钮、精确48,000/48,001字节边界及分次结果。运行见[操作说明](e2e/manual/README.md)；当前只验证入口工具，真人操作/长文阅读仍待，I5未终验。

2026-10-09：Windows MCP辅助进程已改为随应用分发的.NET10自包含exe，运行不再依赖系统PowerShell/.NET Framework。完整测试1132通过/9既有跳过、三闸门通过；开发7/7、目录包组合6/6回归及包审计通过。预定开发/包内四轮120+120秒压力全部通过，句柄增长+10/+4/+21/+7，阈值仍为+32/+64MiB。默认MCP仍关闭；跨机器、真实原生操作/模型及独立运行QA仍待，I5尚未整体验收。下列2026-10-08为旧宿主历史。完整边界见[自包含管道记录](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-i5-self-contained-pipe-20261009.md)。

原生交接修复（2026-10-08）：实际原生回归先在旧顺序失败，再在新顺序通过。生产现在先创建、审计并保留下一个实例，再启动当前转发，仍最多15个转发加1个待连接实例。完整测试1101通过、9既有跳过；资源增长尚须独立定位，I5未验收。详情见[本轮证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-i5-handoff-20261008.md)，以下压力结果为修复前历史。

修复后新目录包26044项审计及开发/包内原生探针通过；120秒预热＋120秒测量的开发/包内连接3224/3232，字节校验正确，但句柄+59/+82均超+32，资源压力仍失败。交接顺序通过不代表资源修复；I5仍未验收。

退出诊断续项：仅诊断副本增加阶段、实例、数值错误与子进程退出状态，不输出异常正文；6项专项通过，生产未改。新旧对照结果分别保留，未重现不等于修复。

> I5资源调查（2026-10-08）：新增实际构建的隔离副本生成工具，比较完整转发、纯管道与TCP仅建连，附资源/任务/线程池/自然GC采样。副本仅作归因，不能替换应用或证明生产修复。见[调查与复跑](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-i5-isolation-20261008.md)。生产压力尚未通过，I5未验收；下面为历史验证。

> I5最新（2026-10-08）：新增原生relay压力探针与4项反例测试；开发/包内120秒预热＋120秒测量的句柄增长+69/+53，超过预设+32，**压力闸门失败，尚未修复**。生产relay未改，外部MCP默认关闭，I5未验收。来源仓库docs/verification-integration-i5-stress-20261008.md保留全部失败/诊断与适用边界；下方为历史结果。

> 2026-10-08原生管道实施进展：Windows宿主已接每实例CreateNamedPipeW远程拒绝/当前用户DACL与受认证loopback relay，默认外部入口仍关闭。最终三闸门及新目录包已验证，阶段尚未验收；1086通过9既有跳过、三闸门exit0；开发4/4、打包3/3、26044项包审计通过。以下旧条目保留历史状态。

<p align="center">
  <img src="src/assets/logo.png" alt="Mimir Desktop" width="120" />
</p>

<p align="center"><b>以 Agent 为核心的一站式科研工作台 · 桌面版</b></p>

<p align="center">文献 · 论文 · 实验 · 图表 · 组会 · 会议截稿 · GPU 服务器 · 语音输入</p>

> 把科研里「查文献、读论文、跑实验、写论文、做汇报」这些事，交给一个能用自然语言指挥的 AI 助手。
> 它能直接操作你的科研空间：搜论文、存文献、编译 LaTeX、生成组会 PPT、盯会议截稿——你说需求，它干活，副作用都会先问你。

---

## 下载安装

到 [**Releases**](https://github.com/hxhy00/Mimir-Desktop/releases) 页面下载对应系统的安装包：

| 系统 | 下载 |
|---|---|
| macOS (Apple Silicon) | `Mimir-arm64.dmg` |
| Windows | `Mimir-arm64-setup.exe` / `Mimir-arm64.exe`（便携版） |
| Linux | `Mimir-arm64.AppImage` / `Mimir-amd64.deb` |

### macOS 安装提示「已损坏，无法打开」？

这是 macOS 对**没有苹果开发者公证**应用的安全拦截，不是文件真的坏了。本项目的安装包未付费做苹果公证，首次打开需要放行一次，两种方法任选：

**方法一：右键打开（最简单）**

1. 把 `Mimir.app` 拖进「应用程序」文件夹
2. 在「应用程序」里**按住 Control 键点击**（或鼠标右键）Mimir 图标
3. 菜单里点「**打开**」→ 弹窗里再点「**打开**」
4. 之后正常双击打开即可，只需操作这一次

**方法二：终端命令（一次清除）**

```bash
xattr -cr /Applications/Mimir.app
```

执行后直接双击打开。

> 仍然报错？确认应用在「应用程序」目录里（不要从 dmg 里直接跑），再执行方法二。

### 首次启动配置

1. 打开 Mimir → 右下角「设置」→「模型管理」→「添加模型」
2. 填入任意 **OpenAI 兼容接口**的地址、模型 ID 和 API Key（DeepSeek / OpenAI / 自建网关 / 本地推理都行），点「测试并添加」
3. 选好科研空间目录（默认 `~/Mimir`），开始对话

---

## 能做什么

| 模块 | 一句话说明 |
|---|---|
| **对话** | 自然语言总入口：查文献、写笔记、编译论文、做 PPT 都在这说 |
| **文献库** | arXiv + 网页双来源搜索、PDF 阅读、笔记、BibTeX、订阅 |
| **论文** | LaTeX 多文件编辑 + 真实编译 + 错误一键 AI 修复 |
| **实验** | 实验记录、指标可视化、训练进度 |
| **图表** | 图片管理、从 PDF 提图、LaTeX 引用同步 |
| **组会** | 从论文与实验自动生成 16:9 PPT |
| **会议截稿** | CCF 会议 deadline 倒计时、星标提醒 |
| **服务器** | SSH 连接 + GPU 显存监控 + 远程终端 |
| **记录** | 成长时间线（里程碑 / 论文 / 实验） |

Agent 侧的关键能力：

- **子代理委派**：复杂任务自动派给「研究员 / 写作编辑 / 实验管理员」等专业角色，过程可见
- **上下文治理**：长对话自动摘要压缩，按真实 token 计量，不会聊着聊着失忆或爆预算
- **权限与安全**：沙箱档位 + 批准卡，写盘前必过确认；控制平面永远硬拒绝
- **产物验收**：生成的文件以卡片形式出现在气泡下方，一键打开
- **多会话并行**：A 会话生成时切到 B 会话继续聊，互不阻塞
- **语音输入**：本地离线识别（SenseVoice）或浏览器引擎

---

## 从源码运行

```bash
# 环境要求：Node.js ≥ 22，包管理器 pnpm
pnpm install        # 安装依赖
pnpm dev            # 开发模式
pnpm build          # 构建产物
pnpm test           # 全量测试（离线，无需 API Key）
```

本机打包：

```bash
pnpm build:mac      # macOS：dmg + zip
pnpm build:win      # Windows：nsis + portable
pnpm build:linux    # Linux：AppImage + deb
```

---

## 常见问题

<details>
<summary><b>macOS 打开报「已损坏」（见上方安装一节的详细教程）</b></summary>

右键 → 打开；或终端执行 `xattr -cr /Applications/Mimir.app`。
</details>

<details>
<summary><b>Dock / 启动台里图标显示异常或没更新</b></summary>

macOS 会缓存图标。替换新版本后如果图标没变，终端执行：

```bash
killall Dock && killall Finder
```

或注销重新登录。
</details>

<details>
<summary><b>LaTeX 编译报引擎缺失</b></summary>

「设置 → 语音与资源」里一键下载内置 **Tectonic** 单文件引擎（免安装、跨平台），或使用本机已有的 latexmk。
</details>

<details>
<summary><b>搜索论文时偶发等待较久</b></summary>

主检索走 OpenAlex（快），仅「按最新提交排序」依赖 arXiv 官方接口——它有官方 3 秒/次的限速，遇到限流会自动熔断稍后恢复，不需要处理。
</details>

---

## 参与开发

架构设计、构建避坑、测试体系、权限安全模型等工程细节见 **[DEVELOPMENT.md](./DEVELOPMENT.md)**。

## 相关项目

- [dsh-Mimir-Academic-research](https://github.com/1692775560/dsh-Mimir-Academic-research) —— 本项目的前身：以 DeepSeek Harness 为宿主的科研工作台插件。Mimir Desktop 是其工程化重写的独立桌面版。

## 科研资产整合进度（自有 fork，2026-10-08）

本轮I5-05C自动回归矩阵见来源仓库[阶段证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-i5-matrix-20261008.md)：完整测试1086通过、9既有跳过；历史资产/AI/MCP主批次27/27（开发19、包内8），0重试；双ABI SQLite按Node→Electron→Node各7/7，目录包26044项审计通过。包内MCP补验2/2通过，合计开发19/19、包内10/10（29/29），0重试；真实交互、跨机器SMB、持续压力、真实模型和独立运行QA仍待，I5未验收。


I0–I4已完成Windows阶段验证，I5已接通草稿、模型动作/标签建议、Agent、资产AI界面及外部MCP协议。本机MCP宿主连接已实现：共用当前科研空间唯一资产writer，独立CLI连接已有桌面，凭据位于Electron用户配置目录的 `assets-mcp/session.json`；默认不开启，不进入同步资产或Git。

外部写请求有独立原生单次确认，默认拒绝，不继承Agent全权权限；完整拟写入参数与草稿采纳正文可审阅，合计超过48,000 UTF-8字节拒绝。取消、空间切换和断连使批准失效；CLI通过纯控制帧保活，不重放写请求。崩溃残留文件不会自动覆盖，须确认所有实例退出后再处理。

**外部MCP仍是开发预览，尚不发布生产客户端配置。** Windows发现文件ACL、管道原生远程拒绝/每实例DACL、本机UNC通路及新目录包审计/闭环已实际验证。跨机器SMB、真实原生点击、48KB可读性及阶段终验仍待；I5整体未验收。自动测试对原生按钮使用返回值替身，不冒充用户验收。源码开发检查入口为 `pnpm typecheck`、`pnpm test`、`pnpm build`；真实桌面连接回归为构建后 `pnpm exec playwright test e2e/specs/30-assets-mcp-host.spec.ts --retries=0`，仅使用临时数据。

Windows x64启用该预览时，桌面按需启动包内隐藏的当前用户辅助进程（.NET10.0.12自包含）。固定位置的完整清单和文件哈希校验通过才启动；缺件或权限初始化失败时，仅该入口关闭，桌面其他功能可继续使用，不回退PowerShell。每个管道实例设置远程拒绝和当前用户权限，转发至仅监听127.0.0.1临时端口的broker；内部端口仍须认证，不替代单次批准或空间校验。辅助进程不读取资产或模型配置，但会接触转发中的认证字节。其它Windows架构尚未支持此预览；macOS/Linux沿用Unix传输。

源码开发若需运行Windows MCP或全量原生测试，先按[开发说明](DEVELOPMENT.md#自包含管道辅助程序开发准备)准备固定.NET SDK，再执行 `pnpm assets:pipe:prepare` 与 `pnpm assets:pipe:check`。普通安装包运行不需要SDK；`pnpm build`只构建应用代码，Windows完整打包使用 `pnpm build:win`。

开发者可在Windows完成构建后运行[原生管道探针](scripts/checkAssetsWindowsPipe.mjs)：

```powershell
pnpm build
node scripts/checkAssetsWindowsPipe.mjs
```

探针使用临时随机管道和echo服务，不写真实资产。它验证连续实例权限、转发、占名和退出；只有未限制对照UNC通路先可达，才将受限管道的访问拒绝记录为REMOTE_DENIED。网络不可达单独报告，不能冒充权限通过。生产客户端配置仍待整体运行验收。

## License

[GPL-3.0-only](LICENSE)（与 `package.json` 的 `license` 字段一致）。本整合仅提交用户自有 fork，不推官方 upstream。

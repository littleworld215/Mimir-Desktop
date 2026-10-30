# Mimir Desktop

2026-10-30 B1/B2增强PDF与摘录已实现并完成开发验证：保留原阅读，增强模式仅读取受管PDF；当前物理页真实选区逐字进入未保存新证据，经过原有离开保护，显式保存才入库且仍未核对。B2定向21项、真实Electron4/4（31.5秒，零重试）；类型/默认全量/构建均exit0，2776通过+9既有跳过（2785项、308文件，202.54秒）。B3填写框架、C1标签、C2量测和F1候选仍待完成，日常安装与真实资料不动。

使用：文献库打开文献后默认仍为原阅读，点击“增强阅读”才读取受管PDF；可输入物理页/缩放，失败可返回原阅读。扫描页不自动OCR；在当前文字层拖选后点击“摘录为证据”；取消不会替换原输入，接收后仍需点击“保存证据”，不会自动核对来源。

<!-- RESEARCH-WORKFLOW-A3-20261030 -->
2026-10-30六项科研优化A组已验证：A1偏好底座、A2导航恢复及A3空证据库新建笔记/证据/矩阵/问题/固定素材/导出/重启闭环。A3开发Electron3/3（42.5秒、零CLI重试），完整类型/全量/构建exit0，2749通过+9既有跳过（2758项、304文件，220.98秒）；新截图目录不写历史I9证据，第二合成空间原字节保留。B组增强PDF/摘录/T2I及C/F组继续；日常file-health-01和真实资料未更换。 [逐批证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-research-workflow-20261030.md)。
<!-- /RESEARCH-WORKFLOW-A3-20261030 -->

<!-- RESEARCH-WORKFLOW-A2-20261030 -->
2026-10-30六项科研优化A2源码验证完成：文献/矩阵/研究子视图按空间恢复有效项目、筛选、位置与当前详情，守卫优先、迟到响应隔离；矩阵加载后滚动及同宿主新scope刷新反例已修复。最终类型/默认全量/构建exit0，2749通过+9既有跳过（2758项、304文件，182.08秒）；开发Electron5/5零CLI重试exit0。PDF页码仅预留可靠位置接口，尚无增强阅读。A3及其它任务继续，日常file-health-01与真实资料不变。 [逐批证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-research-workflow-20261030.md)。
<!-- /RESEARCH-WORKFLOW-A2-20261030 -->

<!-- RESEARCH-WORKFLOW-A1-20261030 -->
2026-10-30六项科研优化开始执行：A1分空间浏览偏好底座已实现，64KiB/最近20篇/白名单及失败保留；六项行为RED→GREEN，最终类型/默认全量/构建exit0，2738通过+9既有跳过（2747项、303文件，216.01秒）。该A1批次仅底座，后续A2接线见上方最新记录；其余任务继续，不称六项验收。日常file-health-01、真实资料及应用锁保持。 [逐批证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-research-workflow-20261030.md)。
<!-- /RESEARCH-WORKFLOW-A1-20261030 -->

<!-- ASSET-FILE-HEALTH-20261029 -->
2026-10-29轻量文件健康报告已按采用的短设计落目标源码：手动分批检查文件资产与历史/归档，明确路径/归属/缺失/可打开状态，摘要未建立、非内容完整性；取消/重检/切换丢弃旧响应，不改库、不读正文、不持久化或自动修复。最终类型/构建、默认全量2732通过/9既有跳过（302文件/2741项，204.40秒）及来源自检exit0；开发Electron6/6、候选10/10均零CLI重试exit0。唯一末尾静态复核C0/I0/M1，取消提示已RED→GREEN修正；不是独立运行QA。已备份优先部署至file-health-01（产品a1bac9f）；实际安装14/14、旧新版互斥2/2均零CLI重试exit0，两处入口正常启动复用同一主窗口；用户已确认本版本正常显示、可以操作。原配置检查只打开健康报告，未主动扫描真实文件，原注册和科研业务字节保持；此前共享系统剪贴板末尾空值的两次失败及未定触发者单列保留。 [本批证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-assets-file-health-20261029.md)。
<!-- /ASSET-FILE-HEALTH-20261029 -->


<!-- ASSET-ACTIONS-20261029 -->
2026-10-29：已按采用的短设计实现资产操作分组与详情层级：13按钮保留，先阅读取用、再管理历史，永久删除独立但确认流程不变；长文操作可达、完整正文和复制核验保持。最终类型/构建、完整2705通过/9既有跳过、来源自检均exit0；独立候选包8/8真实Electron通过、零重试，末尾静态复核C0/I0/M0（非独立运行QA）。已备份优先部署至action-layout-01（产品fa85d56）；实际安装12/12、两代旧新版互斥2/2，零CLI重试exit0。私有原始备份及23条目正式包保留，原注册和科研业务字节不变，缓存/审计/运行旁文件单列。两入口正常启动并复用同一主进程，用户已确认当前新版正常显示、可以操作；工具初始化失败、截图0仍保留。 [本批证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-assets-action-layout-20261029.md)。
<!-- /ASSET-ACTIONS-20261029 -->


<!-- CLIPBOARD-VERIFY-20261029 -->
2026-10-29：用户已采用复制回读核验。详情、快速取用、填值与任务包均在核验后才成功及记使用；失败保留输入，不自动重试/换通道，不输出回读内容。四反例RED→GREEN，聚焦30项及开发Electron4/4通过；完整三闸门exit0（2705通过、9既有跳过），末尾静态复核无问题，候选复制与失败核验2/2通过；日常部署和窗口观察另以证据页为准。 [当前证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-assets-clipboard-20261029.md)。
<!-- /CLIPBOARD-VERIFY-20261029 -->


<!-- ORGANIZING-UI-20261028 -->
2026-10-28：资产整理UI首批源码已实现：分类折叠/计数解释、标签候选搜索、可单项移除的条件摘要、卡片收藏与更新时间；原接口和全部能力保留。真实窄窗反例已集中修正，最终验证见专项。日常安装未更换，I7整体及其它条件验收未完成。 [本轮证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-assets-organizing-20261028.md)。
<!-- /ORGANIZING-UI-20261028 -->

<!-- PAGE-DEPLOYED-20261028 -->
2026-10-28已按批准完成备份优先部署：日常page-metadata-01，原配置/profile/空间及入口保护，正式23条目包独立验包0；仅隔离已批准PID54568两锁，最终152对象私有权限通过。原profile入口/维护取消、系统两入口启动及同主进程复用通过；旧journal保留。原564载荷未变，新增两个已核对空目录单独登记；用户已在本轮明确确认“正常显示，可以操作”，本版本窗口观察完成，整体待验保持。 以下旧版本/待确认记录只代表当时状态，当前以本段为准。 [部署与回退](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-deployment-page-metadata-20261028.md)。
<!-- /PAGE-DEPLOYED-20261028 -->

<!-- PAGE-CYCLE-20261028 -->
2026-10-28查询回归补验：在真实临时SQLite内存入自循环/双节点循环，完整保留外键约束，实际递归读取能结束并返回与旧summary一致的CYCLE错误；单文件14/14、exit0。仅增加测试，不改产品逻辑、schema、接口或安装包。完整类型/全量/构建exit0，2682通过/9既有跳过（2691项、297文件），43重建文件与实际发布一致；部署的PID54568两把残锁仍待确认，日常入口未切换。 [补验记录](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-assets-page-metadata-20261028.md)。
<!-- /PAGE-CYCLE-20261028 -->

<!-- PAGE-METADATA-20261028 -->
2026-10-28当前页批量查询已实现：仅批量读取本页版本、标签与必要分类祖先；事务守卫、检索范围、排序分页和摘要保持。双层50/200条页业务读取由202/802降至5，旧新完整DTO逐字一致。专项28项、完整类型/全量/构建exit0，2680通过/9既有跳过（2689项、297文件）；开发4/4、候选8/8均零重试exit0，两运行时数据库各7/7。末尾静态复核0阻断/1项非阻断测试补充，详见报告；日常journal-01未替换，整体待验范围不变。 [专项证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-assets-page-metadata-20261028.md)。
<!-- /PAGE-METADATA-20261028 -->

<!-- STAGING-CASE-20261028 -->
2026-10-28受管staging大小写修复：Windows真实别名曾把未提交文件写入ZIP；现在清单与来源观察共同核对实际目录身份，保留不同目录及相似名称的普通资料。真实3项RED后集中修正，专项56/56；完整类型/默认全量/构建exit0，2667通过/9既有跳过（2676项、295文件）；开发及候选35号各4/4零重试exit0，Node/Electron SQLite各7/7。一次静态复核无问题，候选审计及剩余边界见专项报告。日常安装仍journal-01，未自动替换；I5/I6/I10整体待验保持。 [专项证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-backup-staging-case-20261028.md)。
<!-- /STAGING-CASE-20261028 -->

<!-- JOURNAL-DEPLOYMENT-20261028 -->
2026-10-28：首次发布修复产品4f87deb已完成备份优先部署，日常独立目录现为20261028-journal-01。566文件摘要一致；实际安装8/8、与两代旧版互斥2/2，均零重试exit0；原profile入口和维护取消通过。配置/profile/空间原始副本及23条目正式备份均保留，未结束进程或处理残锁；注册与科研业务字节不变，公开会议缓存刷新单列。Windows Shell两入口正常启动并复用同一主进程，用户于2026-10-28明确确认“正常显示，可以操作”。旧G08保留可回退；I5/I6/I10及真实课题剩余验收保持。以下历史条目的“未部署”和旧日常版本只描述当时批次，当前状态以此段为准。 [部署与回退](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-deployment-journal-20261028.md)。
<!-- /JOURNAL-DEPLOYMENT-20261028 -->

部署说明首次交付时（用户确认补录之前）重新执行类型检查、默认全量测试及构建均exit0：2662通过/9既有跳过（2671项、294文件），216.41秒；43个重建文件与已安装产物审计一致。当前产品代码仍为4f87deb，未借文档提交改动运行中配置。

<!-- JOURNAL-PUBLICATION-STATUS -->
2026-10-27批次（2026-10-28收齐验证）：Windows恢复记录首次发布修复已完成源码与本机合成验证。独占空占位、文件/完整父链身份及原字节重验后原子替换；已有记录不覆盖，未知残留保留，关闭/清理失败明确报告。最终默认完整类型/测试/构建exit0，2662通过/9既有跳过（2671项、294文件）；开发/最终独立包各52/52、零重试exit0，单/四进程500份及2000次更新无最终失败。一次静态复核集中修复已留RED/GREEN，不称独立运行QA；源码提交见实际记录，日常仍20261027-g08-01，I5/I6/I10条件验收保持。 [本轮证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-journal-initial-publication-fix-20261027.md)。
<!-- /JOURNAL-PUBLICATION-STATUS -->

<!-- I6-V15-STATUS -->
2026-10-27 V15恢复目录安全修复：拒绝目标与源、已登记空间及控制目录重叠；实际junction反例已集中修复，定向52/52。最终单worker完整类型/测试/构建exit0，2628通过、9既有跳过（2637项、292文件）；开发及独立新目录包的受影响恢复组合各50/50，零重试exit0，双ABI各7/7。默认四worker原失败保留；本项源码与候选包已验证，日常安装未更新。初始记录发布短设计另行待审，未实现，不合并为已修复。 [本轮证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-restore-target-safety-20261027.md)。
<!-- /I6-V15-STATUS -->

<!-- G08-CURRENT-STATUS -->
2026-10-27 G-08本机验证及独立目录部署完成：正常资产库绑定定位已修复；单worker完整类型/测试/构建exit0，2614通过、9既有跳过（2623项、291文件）。开发/候选包Electron各51/51；实际安装6/6、旧新版互斥1/1、补正维护测试开发3/3，均零重试exit0。566文件复制摘要一致；正式空间备份23条目、独立验包通过，原注册表与科研正文/资产库未变，公共会议派生缓存刷新单列。两处入口已切换到20261027-g08-01，Windows Shell启动及复用同主实例已核对，用户已实际确认窗口正常显示、可以操作。默认四worker失败、间歇RECHECK触发者、M盘ACL限制及I5/I6/I10条件验收保留；不称全范围终验或独立运行QA。 [本轮证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-backup-comprehensive-20261027.md)。
<!-- /G08-CURRENT-STATUS -->

2026-10-27 G-07源码与候选包验证完成：包内范围说明、恢复前确认及受验证的私有注册快照接通。完整三闸门exit0（2613通过/9既有跳过，共2622项、290文件）；开发和新目录包维护组合各48/48、零自动重试。一次静态复核的两项Important已在单轮反例修复中处理；不称独立运行QA，日常安装未更新，G-08与I6终验仍待。[使用与边界](docs/I6-BACKUP-SCOPE.md)。

2026-10-25 G-06：[原生恢复选择与任务取消](docs/I6-MAINTENANCE-TASKS.md)已通过完整三闸门（2530通过/9既有跳过）及开发/独立候选包维护组合各41/41、零自动重试。首次并行记录RECHECK仍待查；未更新日常安装，G07～08及I6未终验。

2026-10-25 G-05恢复中断处理：[使用与核心逻辑](docs/I6-RESTORE-RECOVERY.md)新增固定UUID的阶段记录、同目录登记重试和确认后暂存核验；稳定分页保证旧任务可达，无锁维护仅只读查看。工程／实际强退／新目录包和一次静态复核分别见[证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-restore-recovery-20261025.md)。日常安装不随源码更新，G-06～08及I5/I6/I10原待验保持。

2026-10-24 G-04恢复关联：[路径/快照/模板规则](docs/I6-RESTORE-ASSOCIATIONS.md)覆盖五类已知结构路径、原始项目键快照与同一新UUID模板，正文和外部引用保持，冲突不合并，未知/外部计数提示。新增可选来源ID，格式1保持；[本轮实际证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-restore-associations-20261024.md)分别记录失败、静态复核、工程与桌面/候选包。日常安装不自动替换。

2026-10-24 G-03资产恢复补强：[兼容与历史附件规则](docs/I6-ASSETS-RESTORE.md)覆盖未来/漂移库拒绝、已知旧库只在恢复暂存副本先快照后迁移，以及全历史附件完整读取。只读自检修正真实路径和包内原生绑定。[实际证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-assets-restore-20261024.md)分别登记运行与静态复核；schema4保持，日常安装未自动更新。

2026-10-24 G-02归档读取补强：验包、恢复预览和解压共用限额/严格元数据，按实际展开流量停止；ZIP/ZIP64目录覆盖、目录空流及错误收尾有回归。[逻辑与上限](docs/I6-ARCHIVE-READ-LIMITS.md)及[实际验证](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-archive-read-limits-20261024.md)。格式1/旧入口保留，日常6645129安装不自动替换，I6全范围待验保持。

2026-10-24 G-01备份一致性补强：来源两次流式观察、遍历末复核、临时包同步/独立验包及实际关闭、输出身份重验、同卷原子不覆盖发布。[逻辑与限制](docs/I6-BACKUP-CONSISTENCY.md)及[本轮证据](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-backup-consistency-20261024.md)分别登记。源码修复不自动更新日常6645129安装，I6其它欠项与I5待验保持。

## 当前安装与使用

当前使用桌面或开始菜单的“Mimir 科研工作台”，两处均指向 `C:/Users/11488/Mimir-Research-Releases/20261028-journal-01/Mimir.exe`；旧G08与完整保护副本保留。源码交付、当前安装及真人观察分别登记，以下保留各批次历史。

当前使用桌面或开始菜单的“Mimir 科研工作台”，两处均指向 `C:/Users/11488/Mimir-Research-Releases/20261028-journal-01/Mimir.exe`；旧G08与完整保护副本保留。源码交付、当前安装及真人验收分别登记，以下为历史记录。

测试设施续项（2026-10-23）：普通Vitest的真实日志出口已定向唯一临时目录，保留文件和控制台日志；3项反例通过，一次静态复核Important已修正并复查，最终完整类型/测试/构建均exit0，2235通过/9既有跳过（262文件2244项），日志哨兵摘要不变。生产代码、日常安装6645129及科研资料不变。开发验证约定见[日志隔离](DEVELOPMENT.md#vitest日志隔离2026-10-23)。

历史部署（2026-10-23）：恢复草稿6645129已部署到独立版本目录，两处快捷方式已切换，Windows Shell正常启动及同主实例核对通过。候选和实际安装各44/44、旧新版互斥1/1，均零重试exit0；完整2232通过/9既有跳过，类型/构建exit0。配置、用户环境、空间原始副本、旧入口与23条目正式备份均保留；仅按用户授权隔离两把原残留锁。业务资料和注册表不变，运行日志、备份审计及会议缓存时间变化单列；正常Shell启动像素可见性未核验。[证据与回退](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-library-drafts-deployment-20261023.md)。

操作参考：[科研阅读整理快速指引](https://github.com/littleworld215/research-asset-library/blob/main/docs/RESEARCH-QUICKSTART.md) · [完整课题试用流程](https://github.com/littleworld215/research-asset-library/blob/main/docs/RESEARCH-PILOT.md)。2026-10-23文献恢复草稿六批源码及隔离目录包验证完成：三类输入显式恢复、冲突/失败保护及备份关联已接通；完整2232通过/9既有跳过，类型/构建exit0，开发/包内各16/16零重试。一次非作者静态复核3项Important已按反例修复，不称独立运行QA；日常版本现为6645129；源码交付记录与部署记录分别保存。见[恢复草稿说明](docs/LIBRARY-RECOVERY-DRAFTS.md)及[原笔记说明](docs/LIBRARY-NOTE-SAFETY.md)。

上一版安装记录（2026-10-22）：文献优化产品276aba3已部署到独立目录，桌面/开始菜单入口已切换并通过Windows Shell可见启动。候选包和实际安装分别36/36、旧新版互斥1/1，均零重试exit0；完整类型/测试/构建exit0（2154通过/9既有跳过）。原配置/profile/整空间和快捷方式已备份，原资料与注册表只读核对不变，旧版可回退。文献库新增日期来源及回收恢复现可使用；无模型调用或T2I实验。[使用与回退](docs/LIBRARY-DEPLOYMENT.md)。下方保留各批次历史状态，不将旧“安装未更新”当作当前状态。

2026-10-22 文献回收站源码验证完成：移除/恢复先预览关联，保留原标识、PDF、笔记和证据/素材历史；重导入不自动复活，活动候选排除回收条目。下载实际寿命内阻止回收，磁盘失败回滚缓存；整空间恢复保留并校验回收/日期元信息。完整三闸门exit0（2154通过/9既有跳过，253文件2163项），补强下载成功断言后全量复跑一致；真实桌面组合24/24零重试exit0，含SQLite/WAL维护恢复。新上下文静态两项Important已修复复查；安装未更新，不称独立运行QA。[操作与边界](docs/LIBRARY-RECYCLE.md)。

2026-10-22 文献日期源码批次完成：分别保留arXiv提交/更新、来源出版及入库时间，年份不补月日，旧记录不猜填；BibTeX不再误用入库年份。完整三闸门exit0（2133通过/9既有跳过，246文件2142项），合成空间开发Electron18/18零重试，深浅主题实拍复核。新上下文静态发现的Agent解析遗漏及实际回归复现的批量请求等待环已修复；未更新日常安装，不称独立运行QA。[说明](docs/LIBRARY-DATES.md)。

2026-10-21 文献笔记/标签和阅读器追加已接入失败保留及正常离开保护；保存后打开读取最新确认文献，解除当前项目关联前检查草稿，完整显示自由前缀及多段笔记。完整类型/原始全量/构建均exit 0（2119通过/9既有跳过）；开发Electron17/17零重试，未更新日常安装。[使用与边界](docs/LIBRARY-NOTE-SAFETY.md)。

2026-10-21 新增独立“库内检索”：离线搜索标题、作者、标识、摘要、已保存笔记和标签，支持多关键词及项目组合；临时过滤保留未保存卡片草稿，结果数与项目总数分开。最终完整三闸门exit 0（2103通过/9既有跳过，242文件/2112项）；开发Electron 10/10零重试，含前批修复及实际筛选草稿保留。日常安装未更新，无大库性能验收结论。[使用与已知边界](docs/LIBRARY-IMPORT-SAFETY.md)。

2026-10-21 文献库源码优化：Web 结果先展示论文候选并由用户明确确认；项目创建/重命名失败保留输入，成功写入后的刷新失败另行提示。候选来源按实际字段显示，默认不选、不自动导入首条。完整类型/原始测试/生产构建均 exit 0（2093通过、9既有跳过，241文件/2102项）；开发Electron 9/9零重试。日常安装保持原版，未迁移真实文献。[操作与后续范围](docs/LIBRARY-IMPORT-SAFETY.md)。

2026-10-21 **I10已完成备份优先的本机部署**：焦点修复产品1d7fde7已安装到独立目录，两处日常入口已切换并通过Windows Shell可见启动。配置/profile/快捷方式、整空间与两个经用户授权隔离的原锁均已保护，旧版可回退。实际安装目录19/19、旧新版互斥1/1均零重试通过；原profile只读核对后注册表及业务文件不变。完整修复快照2077通过/9既有跳过、类型及构建exit0。真实通知/登录自启、macOS和真实课题仍待验，I5/I6原待验保持。[使用与验收](docs/I10-ACCEPTANCE.md) · [交付记录](docs/I10-DELIVERY.md)。

2026-10-20 维护入口部署续验：生产代码618ac52已部署到独立`20261020-maintenance-618ac52`目录，旧I9/I8保留，配置/profile/整空间和旧快捷方式已备份。新增41真实OS重启验收，包内21/21、实际安装目录专项4/4零重试；完整三闸门1956通过/9既有跳过、类型/构建exit0。原profile入口及取消确认通过，新程序已显示，两日常快捷方式经Shell激活通过。最后隐藏Shell启动探针失败及用户授权恢复单列，不冒称首次Shell冷启动或独立运行QA通过。[验证及回退](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-maintenance-release-20261020.md)。下方同日初次交付“安装版仍7441987”保留当时状态。

2026-10-20 源码新增“设置→科研空间→备份与恢复”。先保存设置，再显式确认关闭工作台；原退出保护照常生效，取消关闭后可再次进入。资源结束及写锁释放后才安排维护；入口不会自动备份或覆盖资料。普通桥仅提供固定无参入口。最终类型检查、原始测试及构建均exit0：1956通过、9既有跳过（212文件1965项）；隔离Electron组合23/23零重试。新上下文静态复核无问题，不称独立运行QA。最终系统重启由测试接管，实际同profile维护续接及备份已验证；新目录包与无人干预系统重启待验。日常安装版仍7441987，本轮未更新安装或接触真实资料。[验证记录](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-settings-maintenance-20261020.md)。

2026-10-19 I9小修复与本机部署完成：素材包的问题选项、默认值与失效回退统一限定所属课题；已打开的选卡窗口固定问题身份。回归先RED（2失败/3通过）再GREEN（5/5），完整类型/原始测试/构建均exit0：1948通过、9既有跳过（211文件1957项）。开发Electron13/13、实际安装目录14/14，均零测试重试。新包与实际运行目录审计通过，564文件逐一SHA256一致。配置/用户profile/整空间已备份，原I8及更旧目录保留；两处日常快捷方式已切换到`%LOCALAPPDATA%/Programs/Mimir-Research-Releases/20261019-i9-reviewed-01/`，已从Windows桌面入口实际启动。真实文献及I5/I6其它待验保持；自验不称独立运行QA。[部署与回退记录](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-deployment-i9-20261019.md)。

2026-10-18 I9完成Windows x64源码与隔离目录包交付验证：问题分组/比较、固定版本写作素材、差异更新、Markdown导出、健康/恢复及共用退出保护。最终类型检查/原始测试/构建均exit0：1945通过、9既有跳过（211文件1954项）；开发Electron13/13、新目录包14/14，均零重试。包审计26,075项及193辅助文件通过。一次非作者静态复核后集中修复并重新完整验证，不称独立运行QA。现有I8安装版未替换，真实课题及I5/I6原待验不变；全部项目范围的问题默认选项已知限制见下文。

下方记录按日期保留历史状态；当前安装以2026-10-22文献优化部署记录为准。原I9的[部署记录](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-deployment-i9-20261019.md)和[前一轮验证报告](https://github.com/littleworld215/research-asset-library/blob/main/docs/verification-integration-i9-20261018.md)保留当时结果。

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

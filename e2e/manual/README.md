# Windows 原生批准人工验收

仅显式运行的测试入口，不是产品功能。使用临时用户目录、空模型配置和合成资料；不读取真实科研空间、不调用模型。普通自动测试不发现本目录。

## 准备与启动

Windows x64、Node 22.22.2、pnpm 9.15.9；先按 [DEVELOPMENT](../../DEVELOPMENT.md) 准备原生依赖与管道 helper。关闭其他 Electron 开发实例，在本仓库目录使用 PowerShell：

```powershell
pnpm assets:manual:typecheck
pnpm build
$env:MIMIR_MANUAL_APPROVAL = '1'
pnpm assets:manual:approval --list   # 只列出测试，不启动应用
$env:MIMIR_MANUAL_STEPWISE = '1'     # 推荐：每步暂停，避免同样弹窗连续出现
pnpm assets:manual:approval         # 等待开始指令后才打开当前真实弹窗
Remove-Item Env:MIMIR_MANUAL_APPROVAL
Remove-Item Env:MIMIR_MANUAL_STEPWISE
```

可选设置 `$env:MIMIR_E2E_PACKAGED` 为自己构建且已检查的 Windows 目录包 `Mimir.exe` 绝对路径，使用包内 CLI/helper，不修改已安装程序。未设置时使用本仓库构建产物。

## 单步模式

设置 `MIMIR_MANUAL_STEPWISE=1` 时，每次请求前先暂停。`manual-result.json` 的 `phase: awaiting-step-start` 和 `pendingStep` 给出当前序号、动作及本轮唯一 `controlFile`。说明当前动作后，才向该文件发布当前序号；每步使用新文件名，不提前准备未来步骤。发起请求后 `phase` 为 `awaiting-native-response`；用户完成操作、检查通过才转入下一次暂停。未设置此选项时保留原连续模式。

由Codex陪同验收时，Codex只发布“开始当前测试请求”的指令，用户操作真实按钮；这个文件不授予资产写入权限。独立验收者可在第二个PowerShell终端按报告发布当前序号：

```powershell
$report = Get-Content -LiteralPath '<当前用例目录>/manual-result.json' -Raw | ConvertFrom-Json
if ($report.phase -ne 'awaiting-step-start') { throw '当前未等待开始步骤' }
$pendingFile = $report.pendingStep.controlFile + '.pending'
Set-Content -LiteralPath $pendingFile -Value $report.pendingStep.number -Encoding utf8 -NoNewline
Move-Item -LiteralPath $pendingFile -Destination $report.pendingStep.controlFile
```

先写同目录临时文件再改名，避免读取到半写的空文件；不直接逐字写控制文件。只处理本次测试目录中的文件。错误步骤/指令或文件错误立即失败；每次开始指令等待最多两分钟，取消不继续。此等待发生在请求前，不延长产品单次批准两分钟预算。单步整场上限三十分钟，覆盖最多七次开始等待、六次原生确认及收尾；连续模式仍十五分钟。整场退出会取消步骤等待，超时/失败保留报告与未消费指令，不重放请求。

## 七步操作

保持终端可见，逐项按提示操作，不编辑资料或切换空间。每个批准请求保留产品两分钟时限；单步三十分钟/连续十五分钟整场上限都不会延长单次批准。

1. 按 Enter，确认默认拒绝。
2. 按 Esc，确认拒绝。
3. 点击“拒绝”。
4. 点击“允许这一次”，仅新增一个合成资产，脚本回读正文核对一致。
5. 同一请求再次出现，点击“拒绝”，验证未记住授权。
6. 最终弹窗 detail 恰为 **48,000 UTF-8 字节**。检查 `[合成开头-BEGIN]`、`[合成中间-MIDDLE]`、`[合成末尾-END]`、中文、多行和长行是否完整可读，随后点击“拒绝”。读不全须记录阅读失败，不能仅以弹窗出现判通过。
7. **48,001 字节**请求应无弹窗、直接拒绝，资产总数仍为一。

原生确认 API 只观察并照常转发真实参数、所属窗口、取消信号和返回值，没有自动点击。打开/保存文件窗口仍使用隔离夹具；清理时同步退出提示由夹具接管，不能据此证明那些窗口的真人交互。

## 结果与边界

每次结果存入独立时间目录 `test-results/manual-approval/<时间>/<用例>/manual-result.json`。记录实际确认字节、标记是否存在、响应、资产数量及临时目录/发现文件清理结果，不记录凭据或正文。错误时尝试关闭本次客户端、应用和临时目录；报告失败不会跳过清理。强制结束整个终端可能阻止收尾，须核对本次残留，不能删除其他会话。

即使脚本退出成功，`humanActionAttested: false`、`readability: pending-user-report` 仍保留：响应0不能区分 Enter、Esc、点拒绝或关窗。另行记录执行者、实际动作、Windows版本、分辨率/缩放、三个标记可读情况及失败现象；不要修改自动报告冒充脚本观察。

此入口未覆盖弹窗期间切空间/断连、草稿采纳真人审阅、跨机器 SMB 或真实模型。[I5 验收清单](https://github.com/littleworld215/research-asset-library/blob/main/docs/I5-ACCEPTANCE.md)须分别验收。入口交付不等于 I5 验收完成。

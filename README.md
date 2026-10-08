# Mimir Desktop

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

Windows启用该预览时，桌面按需启动一个隐藏的当前用户辅助进程，依赖系统Windows PowerShell和.NET Framework。每个管道实例在创建时设置远程拒绝和当前用户权限，转发至仅监听127.0.0.1临时端口的broker；内部端口仍须认证，不替代单次批准或空间校验。辅助进程不读取资产或模型配置，但会接触转发中的认证字节。系统策略禁止编译或权限初始化失败时，该入口关闭，桌面其他功能可继续使用；不会自动修改系统策略。

开发者可在Windows完成构建后运行[原生管道探针](scripts/checkAssetsWindowsPipe.mjs)：

```powershell
pnpm build
node scripts/checkAssetsWindowsPipe.mjs
```

探针使用临时随机管道和echo服务，不写真实资产。它验证连续实例权限、转发、占名和退出；只有未限制对照UNC通路先可达，才将受限管道的访问拒绝记录为REMOTE_DENIED。网络不可达单独报告，不能冒充权限通过。生产客户端配置仍待整体运行验收。

## License

[GPL-3.0-only](LICENSE)（与 `package.json` 的 `license` 字段一致）。本整合仅提交用户自有 fork，不推官方 upstream。

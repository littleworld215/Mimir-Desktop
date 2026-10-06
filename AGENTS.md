# AGENTS.md — Agent 入口（本仓库：Mimir-Desktop）

**本仓库是什么**：Mimir-Desktop —— 以 Agent 为核心的一站式科研工作台**桌面版**（React 18 + Electron + TypeScript + Tailwind + Radix/Shadcn，包管理 **pnpm**）。

## 权威约定（先读，按序）

1. **[`DEVELOPMENT.md`](./DEVELOPMENT.md)** —— 架构分层、构建避坑、测试体系、权限与安全模型（**权威**）
2. **[`CODE_STYLE.md`](./CODE_STYLE.md)** —— 代码风格（本仓库**无 ESLint/Prettier**，靠约定与 Review；2 空格、无分号、单引号、LF）
3. **[`CONTRIBUTING.md`](./CONTRIBUTING.md)** —— 环境准备、提交前必做、Conventional Commits、PR 流程
4. **[`ROADMAP.md`](./ROADMAP.md)** —— 演进方向

**提交前必做（硬闸门）**：
```bash
pnpm typecheck && pnpm test && pnpm build
```
**提交信息**：Conventional Commits —— `<type>(<scope>): <中文描述>`（`feat|fix|refactor|docs|test|build|chore|perf`；scope 如 `agent`/`assets`/`settings`/`ipc`/`build`）。

## 使用与许可（个人自用）

- 本仓库当前的工作**仅供用户个人自用**；**永不推回官方 upstream**（`hxhy00/Mimir-Desktop`）；**可以提交到用户自有仓库**（自己的 fork 或其它自有远端）。
- **远端已配置**：`origin` = 用户自有 fork（`git@github.com:littleworld215/Mimir-Desktop.git`）；`upstream` = 官方（`hxhy00/Mimir-Desktop`，仅参考、**不推送**）。提交/推送走 `origin`。
- **许可事实**：本仓库 `README.md` / `CONTRIBUTING.md` / `DEVELOPMENT.md` 声明 **MIT**，但 `package.json` 的 `license` 字段与 `LICENSE` 文件实际是 **`GPL-3.0-only`**（**本仓库自身不一致**）。整合产物为 GPL-3.0 衍生；个人自用范围内不受分发条款约束。
- 因此：**不要**向官方 upstream 推送；提交只进自有仓库。

## 当前任务：把「科研资产库」整合进本仓库

来源仓库（**已冻结**的「科研资产库」，Vue 3 + Fastify 5 + SQLite）位于本仓库同级目录：

```
<来源仓库根> = C:/Users/11488/Desktop/常用共享资料/科研工作台
```

- **整合方案（目标 / 角色 / 约束调整 / 功能映射 / 目标结构 / 阶段 / 验收）**：`<来源仓库根>/docs/MIGRATION-Mimir-Desktop.md` —— **本任务的唯一来源**。
- **角色分工（2026-10-06，D-041）**：Codex 全面负责计划、实现、优化、测试、复核、文档和交付；用户仲裁。不再使用 WorkBuddy 执行，自验不冒充独立 QA。
- **约束已解除**：不再受「准入三问 / 增量优先 / 已拒绝清单 / 许可方向」限制，目标是**尽可能完整**地整合。
- **整合方式**：**推荐重写**以适配本仓库技术栈（React / Electron IPC / Shadcn）；**允许直接移植**与框架无关的纯逻辑（纯函数、数据模型、算法、Prompt 文本）。
- **建议保留**：append-only 版本、备份快照不可变 + 恢复先备份、密钥不进 Git（数据安全，非功能限制）。

### 落点约定（沿用本仓库结构）

- 服务：`electron/assets/`（camelCase 目录，自包含）
- IPC：`electron/ipc/assets.ts`，通道 `assets:*`，返回值统一 `{ ok, ... }`；渲染层传入的路径参数必须在主进程过 `assertRendererPath` 系列校验
- UI：`src/components/modules/assets/`（PascalCase 组件）
- Agent 工具：`electron/agent/tools/assets.ts`；测试：`test/{unit,contract,smoke}`

## 开工 / 收工

- **授权接管例外**：用户明确授权接管未提交工作时，先检查来源工作锁并登记目标已有修改；保留未完成批次，按文件选择提交，不丢弃、不静默代提交；工作区不干净时不自动 pull。
- **开工**：`git status` 干净 → `git pull`（自有远端）→ 读上面「权威约定」→ 读来源仓库的整合方案。
- **收工**：`pnpm typecheck && pnpm test && pnpm build` 全绿 → 按 Conventional Commits 提交（**只推自有仓库**）→ 在整合方案 §7 更新阶段进度。
- **不要 `git add` 来源仓库目录**：本仓库是独立 git，来源仓库与本仓库互不纳入对方提交。

## 常用命令

```bash
pnpm install
pnpm dev            # electron-vite 开发模式（热重载）
pnpm typecheck      # 主进程 + 渲染进程类型检查
pnpm test           # vitest（离线，无需 API Key）
pnpm build          # 完整构建
pnpm start          # 构建后启动，确认「Agent 已从保存的设置初始化」
```

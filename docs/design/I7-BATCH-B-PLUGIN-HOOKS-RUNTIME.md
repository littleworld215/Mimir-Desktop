# 新批次 B · 插件 Hooks 运行时消费接线 架构设计

> 范围来源：`src/components/modules/Plugins.tsx:11` 的既有 TODO 逐字 ——
> 「**插件运行时消费尚未接入**——配置写入 electron/store 后需在 Agent 调度层读取
> `hooks.{onBeforeTool|onAfterTool|onContextReady}` 并在对应生命周期调用。」
>
> 与同文件 `:10` 的现状说明：「插件 / Hooks：本页提供完整的管理（增删改查 + 启用开关）
> 与本地持久化；**作为可管理的配置入口，供后续运行时扩展消费**。」
>
> 本文件是**设计稿**：不改动任何源码、不提交、不碰 git、零新增依赖（实施阶段另计）。
> 目标仓库：`example_demo/Mimir-Desktop`（自有 fork；**不触碰上游 `hxhy00/Mimir-Desktop`**）。
> 当前基线：分支 `main`，HEAD `a54f45a`（批次 A `fs:stat` 落盘后）。
>
> **本稿的裁决结论**：**必须做，但必须「收窄到可安全实现的子集」**——
> 见 §0.3。原始 TODO 设想的 `onContextReady` 与「执行用户脚本」两件事，
> **不宜在本批一并实现**，理由逐条给出。

---

## 0. 设计前提与勘察结论（**决定本批形状的五条硬事实**）

### 0.1 存在**单一工具执行咽喉** `toolTrace.ts`（接线点的最优解，**已核实覆盖两类工具**）

勘察结论：
- `electron/agent/toolTrace.ts:19` 的 `withToolTrace(base, hooks)` 把工具包成代理，
  并**已暴露** `onCall(name,args)` / `onDone(name,out,durationMs)` / `onError(name,error,durationMs)`
  三个回调（`:13-15`），**形状与钩子需求完全吻合**。
- **覆盖面已核实（这是关键）**：它被**两处**调用，合起来覆盖全部工具：
  - `agentService.ts:531-535` —— 主 Agent 全部工具（`guarded.map(...)`）；
  - `capabilityDomains.ts:714` —— **委派子代理**的工具集。
- 且已有**先例**：`agentService.ts:582` 的 `load_memory` 工具**就是**通过
  `withToolTrace(..., { onCall, onDone, onError })` 消费这三个回调（写诊断日志）。
  即「用这三个回调做横切副作用」**是本仓库已验证的既有用法**，不是新发明。
- 对比 `trackedTool.ts`（13 行）：它只做 `trackAgentExecution` 监督 + 信号转发，
  **不携带工具名/参数/结果/错误**；工具名/参数/结果只在 `withToolTrace` 处可得。

**→ 设计含义（**本稿原判为 `trackedTool.ts`，经源码核实后更正为 `toolTrace.ts`**）**：
`agent:beforeTool` / `agent:afterTool` 的调用点**在 `toolTrace.ts` 的 `Hooks` 消费者一侧**
（即 `agentService.ts:534` 与 `capabilityDomains.ts:714` 这两处 `withToolTrace(...)` 调用点），
**不在** `trackedTool.ts`。纠正理由：钩子需要**工具名 + 出入参 + 错误**，
只有 `withToolTrace` 的 `onCall`/`onDone`/`onError` 提供这些；
`trackedTool.ts` 拿不到工具名（`fields.name` 虽在闭包内，但该文件是极热的公共咽喉，
**不宜在其中引入对 store / hooks 模块的依赖**——会让每个工具模块都间接依赖 agent 存储层）。

### 0.2 TODO 里的事件名与 UI 实际选项**不一致**（必须先对齐，否则接线接了个空）

| 来源 | 事件名 |
|---|---|
| TODO 注释（`Plugins.tsx:12`） | `onBeforeTool` / `onAfterTool` / `onContextReady` |
| UI 下拉实际选项（`Plugins.tsx:1408-1412`） | `message:beforeSend` / `message:afterComplete` / `agent:beforeTool` / `agent:afterTool` |

**这是两个不同的命名体系**。UI 是用户实际能写入 store 的选项 → **以 UI 为准**。
TODO 注释里的名字是**早期设计残留**，接线时若按注释写，**永远不会命中任何用户配置**。

**→ 裁决**：本批以 **UI 的四个事件名**为准；同时**更正 TODO 注释**（实施阶段），
使代码与 UI 一致。**`onContextReady` 在 UI 中不存在** → 见 §0.3。

### 0.3 「执行用户脚本」是**安全红线**，本批必须收窄（**核心裁决**）

`HookConfig.actionType`（`Plugins.tsx:114`）有 `script` / `command` / `http` 三种，
`payload` 是用户自由文本。若原样实现「读到就执行」：

- **`command`** = 在主进程里 `child_process.exec(payload)` → **任意代码执行**，
  且 Agent 可被诱导写入 hook 配置（提示注入 → 持久化 RCE）。
- **`script`** = 同上（执行 JS 需要 `vm`/`eval`，主进程沙箱内**无法真正隔离**）。
- **`http`** = 主进程向任意 URL 发请求 → **数据外泄通道**（把工具入参发到外部）。
  现有 `httpFetch`（`electron/http.ts:40`）有 SSRF 防护，但「用 hook 外发」的意图本身需用户明示。

**这三者都不是「接线」，是「开放一个远程代码执行面」**。把这样一个面在**一次批次里静默打开**，
违背 I6 全篇的安全纪律（§「固定边界」：清理超时/失败不得授予交接；旧写者无法确认……均阻断）。

**→ 裁决（本批范围）**：**只接线，不放权**。

| actionType | 本批行为 | 理由 |
|---|---|---|
| `script` | **不执行**；仅记录「已加载但未执行（unsupported）」到 trace | 主进程无法安全隔离 JS |
| `command` | **不执行**；同上 | 等于无沙箱 RCE |
| `http` | **不执行**；同上 | 数据外泄面需专门设计 + 用户逐条明示 |
| （任意） | **钩子注册、匹配、排序、生命周期时机全部接线并测试** | 这是「消费」的骨架 |

即：本批交付**完整的钩子运行时骨架**（谁在何时被触发、顺序、启停、失败隔离），
但**执行器只实现一个「no-op 记录器」**。真实执行器（尤其是需要沙箱/批准链的）
**留待后续批次单独设计**，并须经用户裁决。

> **为什么这样切**：TODO 说的是「运行时**消费**尚未接入」——消费 = 运行时**感知并分派**这些配置。
> 感知与分派本身就是一块完整、可测、无安全风险的工作（且是后续执行器的前提）。
> 把「分派」与「执行」分开，**既完成了 TODO 的可安全完成部分，又不引入未经裁决的 RCE 面**。

### 0.4 读取 store 必须模仿 `capabilityDomains` 的防御式解析

`loadCapabilityDomains`（`capabilityDomains.ts:514`）的范式：
① `getStoreValue` 包 try/catch（store 未就绪不抛）；
② 逐项 `typeof === 'object'` 校验；
③ **只取 `enabled === true`**；
④ 非法项**跳过并记原因**，绝不因一条坏配置全盘失败。

**→ 设计含义**：hooks 加载器**逐字复用这套范式**，不发明新写法。

### 0.5 钩子**绝不能**影响工具本身的执行结果（失败隔离）

工具调用是 Agent 的核心正确性路径。一个用户配错的 hook（抛错、超时）
**绝不能让工具调用失败**——否则「设置里加错一行」就能让整个 Agent 瘫痪。

**→ 设计含义**：钩子分派全程 try/catch + 超时上限，
**任何 hook 异常都吞掉并记日志**，工具照常执行/返回。
这与 `backupService` 的 `safeWriteAudit`（`:255`，审计失败不影响备份）**同一纪律**。

---

## 1. 特性定义（本批的确切范围）

### 1.1 一句话

**在 `trackedTool.ts` 这一咽喉处，按 `plugins:hooks` 里已启用且事件匹配的钩子，
在工具执行前后分派一次「钩子触发」；触发本身零副作用、可观测、绝不干扰工具结果。**

### 1.2 范围边界

| 做什么 | 不做什么 |
|---|---|
| 读 `plugins:hooks`（防御式解析，仅 enabled） | 执行 script / command / http（§0.3） |
| 事件匹配（`agent:beforeTool` / `agent:afterTool`） | `message:beforeSend` / `message:afterComplete`（见 §5.4） |
| 稳定排序（按 store 数组序 / 优先级） | 钩子间的依赖编排 |
| 触发时机正确（before 在工具前、after 在工具后且 after 拿得到结果/错误） | 修改工具入参或返回值（本批 no-op） |
| 每次触发出 trace（只读可观测） | 把 hook 正文/凭据写日志（对齐批次 4 脱敏） |
| 失败隔离（hook 错不影响工具） + 超时上限 | 重试、补偿、回滚 |

### 1.3 非目标（避免范围蔓延）

- **不做** hook 的可视化调试器 / 试运行按钮。
- **不做** hook 的市场 / 导入导出（那是插件管理 UI 的事，已存在）。
- **不做**「hook 修改工具行为」（如改写入参、短路返回）——那需要一个明确的契约设计，
  涉及 Agent 正确性，**必须单独裁决**。

---

## 2. 数据模型（**只读现有形状，不新增字段**）

### 2.1 消费的形状 = UI 已写入的形状

`HookConfig`（`Plugins.tsx:109`）已是落盘契约，**本批不改它**：

```ts
export interface HookConfig {
  id: string
  name: string
  description: string
  event: string                    // 'message:beforeSend' | ... | 'agent:beforeTool' | 'agent:afterTool'
  actionType: 'script' | 'command' | 'http'
  payload: string
  enabled: boolean
  createdAt: string
}
```

### 2.2 主进程侧的最小消费接口（草案）

```ts
// electron/agent/hooks.ts（新增）
export type HookEvent = 'agent:beforeTool' | 'agent:afterTool'
// （message:* 的两个事件本批不接，见 §5.4）

export interface HookDispatchContext {
  readonly event: HookEvent
  readonly toolName: string
  /** before：工具入参摘要；after：结果/错误摘要。**已脱敏**（不含正文/凭据）。 */
  readonly detail: string
}

/** 读 store 并过滤：仅返回 enabled 且 event 匹配的钩子（防御式解析，见 §0.4）。 */
export function loadHooks(event: HookEvent): HookConfig[]

/** 分派一次；永不抛、永不超时拖垮工具（见 §0.5）。返回实际触发的数量供 trace。 */
export async function dispatchHooks(event: HookEvent, ctx: HookDispatchContext): Promise<number>
```

裁决要点：
- **`detail` 必须已脱敏**——工具入参可能含文件内容、URL、token。本批**只放工具名 + 参数键名**
  （不放值），从源头杜绝泄漏（对齐批次 4 审计纪律「不写正文/凭据」）。
- **`loadHooks` 每次调用重读 store**（不缓存）——对齐 `loadCapabilityDomains` 的
  「重载 Agent 即时生效」语义（`Plugins.tsx:8`）。缓存会让用户在 UI 改完必须重启。
  代价：每次工具调用多一次 `getStoreValue`（内存读，可忽略）。

### 2.3 顺序与去重

- **顺序**：按 store 数组中的先后（用户在 UI 里的排列序）。不引入优先级字段
  （无依据的复杂度；需要时用户自己排序）。
- **去重**：不做。同名钩子两条是用户的选择，各触发一次。

---

## 3. 接线点（**唯一改动点**）

### 3.1 接线形状（**在 `withToolTrace` 的 `Hooks` 消费侧**）

`withToolTrace` 已经**按正确时机**调用三个回调（`toolTrace.ts:22/26/30`）：
`onCall` 在 invoke 前、`onDone` 在成功返回后、`onError` 在抛错时。
**故接线无需改 `toolTrace.ts` 的逻辑**，只需在**两个调用点**把钩子挂进回调：

```ts
// agentService.ts:534（主 Agent 工具）
withToolTrace(base as ToolLike, {
  source: { origin: 'main' },
  // 新增：把工具生命周期事件分派给用户钩子（失败隔离，见 §0.5）
  onCall: (name, args) => void dispatchHooks('agent:beforeTool', { toolName: name, detail: redactForTrace(args) }),
  onDone: (name) => void dispatchHooks('agent:afterTool', { toolName: name, detail: '' }),
  onError: (name, error) => void dispatchHooks('agent:afterTool', { toolName: name, detail: redactError(error) })
})

// capabilityDomains.ts:714（子代理工具）——同款三个回调，origin 为 subagent
```

**关键裁决**：
- **不加 `await`**：`withToolTrace` 的三个回调是**同步签名**（`onCall?: (...) => void`），
  改成 async 会牵动 `toolTrace.ts` 的契约。故按**既有先例**（`:582` 的 `console.log`）
  用 `void dispatchHooks(...)` 触发**即发即忘**；`dispatchHooks` 内部自行
  吞错 + 限时（§0.5），**不影响工具结果**。
- **`onError` 也报 `agent:afterTool`**：`withToolTrace` 只有三个回调，
  失败路径由 `onError` 承担——after 钩子在**成功与失败两条路径**都要触发，
  故 `onDone` 与 `onError` 各接一次（互斥，不会重复触发）。
- **`detail` 在 onDone 不给结果**：`onDone` 虽有 `out`，但**本批不把它放进 detail**——
  工具返回值常含正文/大对象，脱敏成本高且易漏。本批 detail 只放「工具名 + 错误类名」，
  **从源头杜绝泄漏**（§4.2）。这是**有意收窄**，非疏漏。

### 3.2 为什么不动 `agentService.ts` 的 `run.toolCalls` 出口

`run.toolCalls`（`agentService.ts:994` 注释）是**流式事件**出口（发给渲染层的 UI 进度）。
Hook 触发是**执行语义**，不是 UI 事件——混进流会污染 UI 协议（新增事件类型 → 渲染层要处理）。
**分离**：在 `withToolTrace` 的回调侧触发 hook；UI 事件照旧走 `toolCalls`。

### 3.3 为什么也能覆盖委派子代理（不漏）

`capabilityDomains.ts:714` 同样用 `withToolTrace` 包装子代理工具集，
故子代理调工具时，`agent:beforeTool` / `agent:afterTool` **同样触发**。
「主 Agent 与子代理口径一致」由**同一个包装函数**保证——不靠两处手工同步。

---

## 4. 安全与纪律

### 4.1 本批不引入新的能力边界（**最重要的一条**）

因为执行器是 no-op，**本批不新增任何 IPC 通道、不新增任何文件写入、不新增任何网络调用**。
`HookConfig` 的 `payload` 本批**只被读取用于生成 trace 摘要的长度**，不被求值。
**这使本批成为一个「零安全面扩张」的改动**——这是选择这个切法的核心价值。

### 4.2 脱敏口径（对齐批次 4）

- trace 里**只记**：`{ event, hookId, hookName, actionType, outcome: 'dispatched'|'unsupported'|'failed', detailKeys }`。
- **不记**：`payload` 原文、工具入参值、工具返回值、任何路径/URL/凭据。
- 失败只记错误**码/类名**，不记 message（message 可能含路径）。

### 4.3 可观测落点

复用既有 trace 设施（`electron/agent/toolTrace.ts` 或 `otelTrace.ts` 择一，实施时确认），
或退化为 `log.info` 一行（对齐 `trackedTool` 现有的轻量风格）。

---

## 5. 未决点与后续（**诚实列出**）

### 5.1 `message:beforeSend` / `message:afterComplete` 本批不接

这两个事件属于**对话消息生命周期**（不是工具生命周期），触发点在 `agentService` 的
消息发送/完成处，**与工具咽喉不是同一个点**。分两个批次接更清晰：
本批交付工具侧（`agent:*`），消息侧留后续。

### 5.2 真实执行器（script/command/http）需要独立设计

至少需要：
- 沙箱方案（`command`：如何限制子进程能力？Windows 上 `AppContainer`/`JobObject`？）；
- 批准链（对齐 `approval.ts`：hook 首次使用是否要用户批准？「记住」语义？）；
- 出网策略（`http`：白名单域名？额度？）；
- 幂等/重试（hook 失败是否重试？）。

**这些都没有现成答案，必须用户裁决**，故不在本批。

### 5.3 `onContextReady` 不存在于 UI

TODO 注释提到的第三个事件名在 UI 中**没有对应选项**。裁决：
**以 UI 为准，`onContextReady` 不实现**；实施时更正注释（§0.2）。

### 5.4 性能

每次工具调用 +2 次 store 读（before/after 各一次）。工具调用频率不高（用户交互驱动），
可忽略。若未来高频，可加「store 版本号」缓存——**本批不做**（无实测压力，避免过早优化）。

---

## 6. 实施分批（**供后续批次参考**）

| 分批 | 内容 | 依赖 |
|---|---|---|
| B1 | `electron/agent/hooks.ts`：`loadHooks` 防御式解析 + 单测 | 无 |
| B2 | `dispatchHooks` no-op 记录器 + 失败隔离 + 脱敏 + 单测 | B1 |
| B3 | `trackedTool.ts` 接线（before await / after 含错误路径）+ 单测 + 变异 | B2 |
| B4 | 更正 `Plugins.tsx:11` 注释（事件名对齐 UI、移除 `onContextReady`） | B3 |

---

## 附：本稿纪律遵守声明

- **零源码改动**：本稿只产文档，`electron/`、`src/`、`shared/`、`package.json` 未动。
- **零新增依赖**。
- **未提交**（本稿在工作区，由后续提交统一入库）。
- **未操作真实用户资料**，未启动真实已安装的 Mimir。
- **未触碰上游** `hxhy00/Mimir-Desktop`。
- 所有勘察结论均**基于对当前 HEAD `a54f45a` 源码的直接阅读**，引用的行号可复核。

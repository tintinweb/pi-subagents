# @tintinweb/pi-subagents

<!-- full-readme: README.md · https://github.com/tintinweb/pi-subagents/blob/master/README.md -->

<p align="center">
  <a href="README.md">English</a> ·
  <b>简体中文</b> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a>
</p>

> 本文是英文 README 的部分翻译（机器翻译，欢迎指正），仅包含简介、功能、安装、快速开始和 `/agents` 命令。UI、自定义代理、工具参数、设置与默认值、事件、RPC 等其余内容仅提供英文版：[完整英文 README](README.md)。
>
> *Partial translation of the English README. Full reference: [README.md](README.md) · https://github.com/tintinweb/pi-subagents/blob/master/README.md*

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/tintinweb/pi-subagents/raw/master/media/logo-dark.svg">
    <img src="https://github.com/tintinweb/pi-subagents/raw/master/media/logo-light.svg" alt="@tintinweb/pi-subagents" width="520">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tintinweb/pi-subagents"><img src="https://img.shields.io/npm/v/@tintinweb/pi-subagents?color=cb3837&logo=npm" alt="npm 版本"></a>
  <a href="https://www.npmjs.com/package/@tintinweb/pi-subagents"><img src="https://img.shields.io/npm/dm/@tintinweb/pi-subagents" alt="npm 下载量"></a>
  <a href="https://github.com/tintinweb/pi-subagents/actions/workflows/ci.yml"><img src="https://github.com/tintinweb/pi-subagents/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/tintinweb/pi-subagents/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/@tintinweb/pi-subagents" alt="许可证：MIT"></a>
</p>
<p align="center">
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/pi-%E2%89%A5%201.1.0-6f42c1" alt="需要 pi >= 1.1.0"></a>
  <a href="https://pi.dev/packages/@tintinweb/pi-subagents"><img src="https://img.shields.io/badge/pi.dev-package-5b5bd6" alt="pi.dev 包"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-compatible%20tools%20%26%20workflows-d97757" alt="兼容 Claude Code">
  <a href="https://github.com/tintinweb/pi-subagents/commits/master"><img src="https://img.shields.io/github/last-commit/tintinweb/pi-subagents" alt="最近提交"></a>
</p>

<h3 align="center">为 pi 提供 Claude Code 风格的子代理与工作流编排。</h3>

<p align="center">
  <a href="#安装"><b>安装</b></a> ·
  <a href="#快速开始"><b>快速开始</b></a> ·
  <a href="README.md#ui"><b>UI (EN)</b></a> ·
  <a href="README.md#custom-agents"><b>自定义代理 (EN)</b></a> ·
  <a href="README.md#tools"><b>工具 (EN)</b></a> ·
  <a href="README.md#persistent-settings"><b>设置 (EN)</b></a> ·
  <a href="https://github.com/tintinweb/pi-subagents/blob/master/docs/workflows.md"><b>工作流 (EN)</b></a> ·
  <a href="https://github.com/tintinweb/pi-subagents/blob/master/CHANGELOG.md"><b>更新日志 (EN)</b></a>
</p>

<p align="center"><code>pi install npm:@tintinweb/pi-subagents</code></p>

一个 [pi](https://pi.dev) 扩展，为 pi 带来 **Claude Code 风格的自主子代理与工作流编排**。启动在独立会话中运行的专用代理，每个代理都有自己的工具、系统提示词、模型和思考级别。你可以让它们在后台运行（默认），也可以阻塞等待；可以在运行中引导它们、恢复已完成的会话，还可以定义自己的代理类型。当编排不应临场发挥时，可以把一段确定性的 JavaScript 脚本交给 `SubagentWorkflow` 工具（`agent()`、`parallel()`、`pipeline()`），为 Claude Code 的 `Workflow` 工具编写的脚本无需修改即可在这里运行。

<img width="600" alt="pi-subagents 截图" src="https://github.com/tintinweb/pi-subagents/raw/master/media/screenshot.png" />


https://github.com/user-attachments/assets/8685261b-9338-4fea-8dfe-1c590d5df543

<img width="600" alt="pi-color-badges-white" src="https://github.com/user-attachments/assets/555dcae4-333e-4ff0-b420-7b3369c018a4" />


## 功能

- **与 Claude Code 一致的外观与体验**：相同的工具名、调用约定和 UI 模式（`Agent`、`get_subagent_result`、`steer_subagent`），用起来就像原生功能
- **并行后台代理**：启动多个并发运行的代理，自动排队（并发上限可配置，默认 10）。完成通知会在父代理的下一个边界送达；多个代理同时完成时，通知会一起送达
- **实时小组件 UI**：编辑器上方常驻的小组件，带动画加载指示、实时工具活动、token 计数和彩色状态图标。通过 `/agents → Settings → Widget` 配置：`all`（所有代理）、`background`（默认，隐藏前台运行的代理，因为它们已作为 `Agent` 工具结果内联显示）或 `off`
- **FleetView**：在编辑器下方显示的 Claude Code 风格的可导航列表，包含 `main` 和所有正在运行的子代理（最早启动的排在最前）。在空提示符下按 `↓`（或 `←`）进入，`↑`/`↓` 移动选择，`Enter` 打开所选代理的实时自动更新对话，`Esc` 返回。已完成的代理会短暂保留后再移出列表；查看器在代理完成后仍保持打开，方便你阅读最终输出。通过 `/agents → Settings → Fleet view` 开关
- **对话查看器**：在 `/agents` 中选择任意代理，即可打开实时滚动的浮层，显示其完整对话（自动跟随新内容，向上滚动即暂停）。在 pi 的全屏模式下，它是一个无边框、占满整个终端、支持鼠标的查看器。按 `Enter` 打开输入框，输入内容后再按 `Enter` 发送，即可内联引导正在运行的代理（`Esc` 或提交空内容则返回）。这条消息会作为用户消息显示，并在代理当前的工具调用结束后调整其工作方向。在正在运行的前台 `Agent` 调用上按 `b`，可将该运行转到后台（参见[将前台代理转到后台](#将前台代理转到后台)）。按 `x`（再按一次 `x` 确认）可停止仍在运行的代理；引导和停止同样适用于后台代理。工具调用的显示方式与 pi 自身的对话记录一致，使用代理会话中注册的渲染器：bash 调用显示命令和输出，`read` 显示行号，`edit` 显示 diff，扩展工具使用自己的渲染器，没有渲染器的工具则回退为显示参数和截断后的输出预览。`ctrl+o`（或 `app.tools.expand` 绑定的任意按键）可展开被折叠的工具输出。助手文本以 Markdown 渲染；按 `m` 可在关闭、仅助手、全部三种模式之间循环切换（参见 [Viewer markdown](README.md#persistent-settings)）
- **自定义代理类型**：在 `.pi/agents/<name>.md` 或 `.agents/agents/<name>.md`（项目级）或全局位置定义代理，使用 YAML frontmatter：自定义系统提示词、模型选择、思考级别、工具限制，以及兼容 Claude Code 的彩色名称徽标
- **随包分发的代理**：pi 包可以在其 `package.json` 中用 `"pi": { "subagents": { "agents": ["./agents"] } }` 声明自己的子代理（以及工作流脚本），这样只需 `pi install` 即可完成全部配置：无需在每台机器或每次容器启动时把文件复制到 `.pi/agents/`。只读取 pi 实际安装的包（绝不读取 `node_modules`），包中定义的代理优先级低于你自己编写的所有代理，`/agents` 以只读方式显示它们，并提供 Eject 和 Disable。用 `packageAgents` / `packageWorkflows` 缩小范围或关闭此功能。**[完整指南](https://github.com/tintinweb/pi-subagents/blob/master/docs/packages.md)**
- **嵌套子代理**：需主动开启、默认关闭的委派功能：设置了 `allowed_subagents` 的自定义代理会获得自己的 `Agent`、`get_subagent_result` 和 `steer_subagent` 工具（作用范围仅限它自己的子代理），嵌套深度从主会话起算有上限（默认 2）。它只能控制自己的子代理；它结束时，这些子代理会被停止，其对话记录和 token 开销也会汇总到它名下。该允许列表是一道权限边界：子代理使用自己的工具运行，因此要像选择 `tools:` 本身一样谨慎地选择它
- **代理提及**：子代理是一等公民：在提示符中输入 `@explore also check the RPC path`，这段话会发给该代理而不是主模型，且不会有任何内容进入聊天。同一种语法覆盖整个生命周期：在它运行时给它发消息，在它完成后恢复它，很久以后再从磁盘重新打开它的会话，或者在它从未运行过时启动它。提及一个未在运行的代理时，会通过一个不在界面上显示的克隆对话来启动它，因此它能获得 Claude Code 那种根据上下文编写的提示词和一次真正的 `Agent` 工具调用，同样不会有任何内容进入聊天；`direct` 模式则直接用你的文本启动它，完全不调用模型。编排者可以给代理设置 `name`，这样你就能用 `@auth-audit` 指代它，`steer_subagent`/`get_subagent_result` 也接受这类名称。`@` 会与 pi 的文件补全一起补全正在运行的代理、可恢复的代理和可启动的类型；`@main` 强制把文本发回主模型。通过 `/agents → Settings → Agent mentions` 开关
- **脚本化工作流**：`SubagentWorkflow` 工具运行一段确定性的 JavaScript 脚本来编排多个子代理：`agent()`、`parallel()`、`pipeline()`、`phase()`、`log()` 和 `args`，并用一个纯字面量的 `meta` 块声明各阶段。`pipeline()` 的各阶段之间没有屏障，因此一个条目可能已进入后面的阶段，而另一个还在第一阶段；`parallel()` 则不同，它会让所有较快的代理空等，直到最慢的那个完成。工作流在后台运行并显示实时卡片，可通过 `/agents → Workflows` 或在 FleetView 中选择该运行来查看。`agent()` 还接受 `gate: "npm test"`，通过运行一条命令（隔离时在其 worktree 中运行）来验证子代理，而不是询问另一个模型；`resume: "<label>"` 用于继续一个子代理，而不必重复承担它的上下文开销。脚本在 worker 线程上的 `node:vm` 沙箱中运行，其中 `Date.now()`、`Math.random()` 和 `eval` 会抛出异常。默认开启，但遇到同类会主动让位：如果另一个扩展已经提供了 `Workflow` 或 `SubagentWorkflow` 工具，本扩展会发出警告并在本会话中禁用自身，而不是给模型提供两个编排器。可在 `subagents.json` 中用 `"workflowsEnabled"` 或通过 `/agents → Settings → Workflows` 将其固定为开启或关闭。为 Claude Code 的 `Workflow` 工具编写的脚本无需修改即可在这里运行：全局变量相同，`schema` 返回经过校验的对象，与在 Claude Code 中完全一致；`budget` 存在，但始终报告没有 token 目标（pi 没有这样的指令），因此以 `budget.total` 作为条件的写法仍会走它们原本预期的分支；嵌套的 `workflow()` 可以组合已保存的工作流，最多一层。**[完整指南](https://github.com/tintinweb/pi-subagents/blob/master/docs/workflows.md)**
- **运行中引导**：向正在运行的代理注入消息，无需重启即可改变其工作方向
- **会话恢复**：从代理停下的地方继续，保留完整的对话上下文。默认以分离方式恢复，并在完成时通知你，与新启动的代理一样；传入 `run_in_background: false` 则阻塞等待并内联获取结果
- **轮次上限时优雅收尾**：代理在被强制中止前会收到“收尾”警告，从而产出干净、可用的部分结果，而不是被截断的输出
- **代理类型不区分大小写**：`"explore"`、`"Explore"`、`"EXPLORE"` 都可以。如果一个类型无法解析为恰好一个**已启用**的代理（未知、已禁用，或两个代理仅大小写不同导致歧义），则会回退到 general-purpose 并附带说明；若设置了 [`fallbackSubagent: none`](README.md#persistent-settings)，则直接拒绝
- **模糊模型选择**：按名称（`"haiku"`、`"sonnet"`）而非完整 ID 指定模型，并自动筛选出可用/已配置的模型
- **上下文继承**：可选择把父对话分叉给子代理，让它了解之前讨论过的内容
- **持久化代理记忆**：三种作用域（project、local、user），对没有写入工具的代理自动回退为只读
- **Git worktree 隔离**：在隔离的仓库副本中运行代理；完成时变更会自动提交到分支
- **技能预加载**：把指定的技能注入代理的系统提示词，从 `.pi/skills/`、`.agents/skills/` 和全局位置查找技能（支持 pi 标准的 `<name>/SKILL.md` 目录布局）
- **工具黑名单**：通过 `disallowed_tools` frontmatter 屏蔽特定工具
- **带样式的完成通知**：后台代理的结果渲染为带主题的紧凑通知框（图标、统计、结果预览），而不是原始 XML。可展开显示完整输出。成组完成时，每个代理分别渲染
- **事件总线**：通过 `pi.events` 发出生命周期事件（`subagents:created`、`started`、`completed`、`failed`、`steered`、`compacted`）和逐条消息的开销明细（`subagents:usage`），让其他扩展能够响应子代理的活动
- **跨扩展 RPC**：其他 pi 扩展可以通过 `pi.events` 事件总线（`subagents:rpc:ping`、`subagents:rpc:spawn`、`subagents:rpc:stop`、`subagents:rpc:consume`、`subagents:rpc:steer`）启动、停止、引导和等待（join）子代理。回复信封格式统一，并带有协议版本。会话开始时发出 `subagents:ready`。**[完整参考](https://github.com/tintinweb/pi-subagents/blob/master/docs/rpc.md)**
- **定时子代理**：向 `Agent` 工具传入 `schedule`，按 cron、固定间隔或一次性时间触发。任务作用域为会话，持久化存储使用 PID 锁；结果以与手动启动的后台代理相同的完成通知送达；通过 `/agents → Scheduled jobs` 管理
- **模型范围约束**：需主动开启的校验，确保子代理选用的模型在你的 pi `enabledModels` 允许列表之内（来源为 `/scoped-models`，全局和项目本地的 pi 设置都会生效）。调用方指定了范围外的模型时，直接向编排者返回错误；frontmatter 固定了范围外的模型时，发出警告但照常运行（以 frontmatter 为准）。通过 `/agents → Settings → Scope models` 开关

## 安装

```bash
pi install npm:@tintinweb/pi-subagents
```

或在开发时直接加载：

```bash
pi -e ./src/index.ts
```

需要 pi **1.1.0 或更高版本**：pi 0.86 和 0.87 把系统提示词和对话历史移入了会话记录（session transcript），而 `@handle` 对话克隆和代理对话记录文件都建立在这一模型之上。`peerDependencies` 范围中声明了这一要求，因此安装时 npm 会对较旧的 pi 发出警告。

### 其他宿主

本扩展针对 [pi](https://pi.dev) 开发和测试。

有第三方报告称，借助适配器可以在其他宿主中运行本扩展。这些适配器独立于本项目维护：未在此测试，不在我们的 CI 覆盖范围内，任何版本都可能破坏兼容性。

- **DeepSeek Harness (`dsh`)**：通过一个把 pi 的宿主 API 映射到原生 DSH 代理的适配器运行。详情和报告：[#258](https://github.com/tintinweb/pi-subagents/issues/258)

## 快速开始

父代理使用 `Agent` 工具启动子代理：

```
Agent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

代理默认在后台运行：调用会立即返回一个 ID，并在完成时通知你，通知中带有结果预览（使用 `get_subagent_result` 获取全文）。传入 `run_in_background: false` 则会阻塞直到代理完成，并内联获得完整输出；阻塞期间按 `ctrl+b` 可将其转到后台（见下文）。

### 将前台代理转到后台

在前台 `Agent` 调用运行期间按 `ctrl+b`，即可将其转到后台，与 Claude Code 中的做法相同。同一次运行会继续进行（同一会话、进行中的轮次、对话记录和 worktree），被阻塞的调用会返回代理 ID，效果与使用 `run_in_background: true` 启动时相同。之后，完成通知会以普通后台通知的形式送达，并注明原来的工具调用。2 秒后，正在运行的调用所在行会显示 `(ctrl+b to run in background)`。

- `ctrl+b` 会一次性转移所有正在运行的前台 `Agent` 调用。若只想转移其中一个，在它的对话查看器（FleetView 或 `/agents → Running agents`）中按 `b`。
- 只有在有这样的调用正在运行且提示编辑器拥有焦点时，扩展才会占用该按键；其余时间（以及在对话框或查看器的引导输入框中），`ctrl+b` 仍执行 pi 的光标左移。禁用 FleetView 时，扩展无法得知哪个组件拥有焦点，因此只要有调用在运行就会占用该按键。
- 每批并行调用只显示一条提示，显示在最早启动且仍在运行的调用上。
- 在父代理中按 Esc 对已转到后台的代理不再生效。请在 `/agents → Running agents` 中用 `x` 停止它。
- 这是单向操作：无法再切回前台。
- 同一条助手消息中的其他工具调用仍会阻塞模型的下一轮，直到它们完成；pi 把一条消息中的所有工具调用作为一批运行。
- 以下情况不提供此功能：仍在排队等待空位的前台调用、前台 `resume`、工作流中的代理，以及嵌套子代理。没有自动超时。

### 定时调度

添加 `schedule` 字段，将代理登记为稍后触发，而不是立即运行：

```
Agent({
  subagent_type: "Explore",
  prompt: "Look at recent commits and summarize what changed since last week",
  description: "Weekly commit review",
  schedule: "0 0 9 * * 1",   // 9am every Monday (6-field cron)
})
```

调度格式：

- **Cron**：6 个字段（`second minute hour day-of-month month day-of-week`），例如 `"0 0 9 * * 1"` 表示每周一上午 9 点，`"0 */15 * * * *"` 表示每 15 分钟。
- **间隔**：`"5m"`、`"1h"`、`"30s"`、`"2d"`。按该间隔重复触发。
- **一次性（相对时间）**：`"+10m"`、`"+2h"`、`"+1d"`。在相应的未来时刻触发一次。
- **一次性（绝对时间）**：完整的 ISO 时间戳，例如 `"2026-12-25T09:00:00.000Z"`。

调度触发时，代理在后台运行，其完成通知的送达方式与手动启动的后台代理相同，父代理也会以同样的方式处理结果。

调度**作用域为会话**：执行 `/new` 时重置，执行 `/resume` 时恢复。通过 `/agents → Scheduled jobs` 查看和取消（创建由 `Agent` 工具负责，没有另外的手动创建向导）。存储在 `<cwd>/.pi/subagent-schedules/<sessionId>.json`，使用基于 PID 的文件锁保证多实例安全。

**完全禁用此功能**：`/agents → Settings → Scheduling → disabled` 会从 `Agent` 工具定义中移除 `schedule`（不占用 LLM 上下文），隐藏对应菜单项，并停止所有活动的调度器。工具定义层面的移除在下一个 pi 会话生效；运行时的停止立即生效。可在同一菜单中重新启用。

限制：
- `schedule` 不能与 `inherit_context`（触发时不存在父对话）或 `resume`（调度总是创建新代理）同时使用。
- `run_in_background: false` 会被拒绝：定时任务始终在后台运行。省略该参数或传入 `true` 均可。
- 定时触发会绕过 `maxConcurrent` 队列，因此 5 分钟间隔的任务不会被长时间运行的手动代理推迟。
- **无头模式（headless）的 `pi -p` 不会等待定时子代理。**

## 命令

| 命令 | 说明 |
|---------|-------------|
| `/agents` | 交互式代理管理菜单：代理类型、正在运行的代理、定时任务、工作流运行、设置 |

工作流检查器、CLI 参数等详情见[英文 README](README.md#commands)。

## 更多详情（英文）

本文仅为部分翻译；未涵盖的内容请参阅[完整英文 README](README.md)。

- [UI](README.md#ui)：FleetView、全屏对话查看器、代理提及
- [默认代理类型](README.md#default-agent-types)与[自定义代理](README.md#custom-agents)：frontmatter 字段、嵌套子代理、工具与扩展范围
- [工具](README.md#tools)：`Agent`、`SubagentWorkflow`、`get_subagent_result`、`steer_subagent` 的参数表
- [持久化设置](README.md#persistent-settings)：所有设置项及其默认值
- [事件](README.md#events)与[跨扩展 RPC](README.md#cross-extension-rpc)
- [工作流指南](docs/workflows.md)、[RPC 指南](docs/rpc.md)、[随包分发的代理](docs/packages.md)
- [更新日志](CHANGELOG.md)

## 许可证

MIT — [tintinweb](https://github.com/tintinweb)

Full README (English): [README.md](README.md) · https://github.com/tintinweb/pi-subagents/blob/master/README.md

<!-- source: README.md @ 399f50e -->

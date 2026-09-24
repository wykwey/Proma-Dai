# Proma Dai

Proma Dai 是 [Proma](https://github.com/ErlichLiu/Proma) 的 fork，一个本地优先的桌面 AI Agent 工作台。界面用 Electron + React，Agent 运行时用 Pi Agent SDK，数据全部以 JSON / JSONL 文件保存在本地。

它跟上游一样有 Chat 和 Agent 两种模式：简单问答用 Chat，需要读写本地文件、跑命令、串多步任务时用 Agent。区别在于本仓库是个人本地化改造版——裁掉了不少上游模块，也没有跟进上游后续版本，所以它和上游 Proma 不是同一个东西。

## 与上游 Proma 的关系

**基于上游 [Proma](https://github.com/ErlichLiu/Proma) 0.16.11 ，上游 版本0.17–0.19 的改动并未进行合并。**

**移除**：

- ：Claude Agent SDK 支持（Agent 只剩 Pi runtime ）；
- 自动更新（升级改为手动下载）；
- 内置的 docx / pptx / xlsx 三个办公 Skill；
- 「内置工具」入口以及 `ToolSettings`、`MemorySettings` 等设置页。
- 飞书 / 钉钉 / 企业微信机器人桥接、Chat 内置工具（联网搜索、nano-banana 图像）
- 语音听写与朗读、Scratch Pad、EventKit 日历集成、启动闪屏、macOS Agent Island。

**增加 / 改造**：

- 打包：新增 Linux `deb` / `rpm` 产物，CI 覆盖 Windows x64、Linux x64、Linux arm64（arm64 改用系统 `fpm`）。
- 体积：CLI 运行时改用 Electron 的 Node 模式加载，打包时按平台过滤原生依赖。
- 依赖：Pi SDK 升到 `0.85.1`，附带两个本地 patch。
- 配置：模型可以单独设置最大上下文窗口。

## 安装与上手

从 [GitHub Releases](https://github.com/wykwey/Proma-Dai/releases) 下载安装包。CI 产出 Windows x64、Linux x64 和 Linux arm64；本仓库的打包配置只有 Windows 和 Linux，macOS 需要自己补配置。

**没有自动更新**，装新版本要手动下载覆盖。

首次使用：

1. 完成环境检查，Agent 依赖本机的 Node.js 和 Git。
2. Windows 需要 Git Bash 或 WSL，在设置的「关于/更新」页里选用哪个。
3. 到 **设置 > 模型配置** 添加渠道，填 Base URL、API Key 和模型列表。
4. 之后 Agent 会话就能用任意已启用渠道的模型。

## 开发

需要 Bun、Git，以及能跑 Electron 的桌面环境。本仓库用 Bun 管理依赖，不要混用 npm / pnpm / yarn。

```bash
bun install        # 安装依赖
bun run dev        # 启动开发环境（Vite + Electron，带热重载）
bun run typecheck  # 类型检查
bun run test       # 运行测试
bun run build      # 构建全部 workspace
```

CLI 单独跑：

```bash
cd apps/cli
bun run start      # 从源码运行
bun run build      # 编译为单文件
```

## 打包

```bash
cd apps/electron && bun run dist   # 当前平台
bun run dist:win                   # Windows
bun run dist:linux                 # Linux
```

打包前会先执行 `sync:runtime-deps`，把主进程以 external 方式加载的 Pi SDK 及其原生依赖同步到 `apps/electron/node_modules`，并按目标平台过滤变体。`electron-builder.yml` 还会额外塞进三样东西：

- `resources/bin/`：打包好的 proma CLI
- `default-skills/`：内置 Skills 模板，首次启动同步到 `~/.proma/default-skills/`
- `resources/tutorial.md`：应用内教程和欢迎对话用的教程文本

## 项目结构

```text
apps/
├── cli/             # proma 命令行工具
└── electron/        # Electron 桌面应用
    ├── default-skills/   # 随应用分发、同步到工作区的内置 Skills
    ├── resources/        # 图标、教程、CLI 产物等打包资源
    ├── scripts/          # 构建、打包、依赖同步脚本
    └── src/
        ├── main/         # 主进程：Agent 编排、渠道、工作区、定时任务、存储
        ├── preload/      # context bridge（window.electronAPI）
        └── renderer/     # React 界面
packages/
├── core/            # Provider adapter、SSE、代码高亮
├── session-core/    # 会话读取、分组、搜索、导出（CLI 与 App 共用）
├── shared/          # 共享类型、配置和工具
└── ui/              # 共享 React 组件
patches/             # 第三方依赖 patch
```

主进程的关键模块都放在 `apps/electron/src/main/lib/` 下，Agent 编排在 `agent-orchestrator.ts`，Pi 适配和渠道映射在 `adapters/`，工作区、会话、定时任务分别在 `agent-workspace-manager.ts`、`agent-session-manager.ts`、`automation-manager.ts`。

## 数据存放位置

数据放在 `~/.proma/`（开发模式或 `PROMA_DEV=1` 时是 `~/.proma-dev/`）。目录名沿用了上游的 `.proma`，没有改成 `.proma-dai`。

```text
~/.proma/
├── channels.json          # 渠道配置，API Key 经 safeStorage 加密
├── conversations.json     # Chat 会话索引
├── conversations/         # Chat 消息
├── agent-sessions.json    # Agent 会话索引
├── agent-sessions/        # Agent 消息
├── agent-workspaces/      # 每个工作区一个目录
│   └── {slug}/
│       ├── workspace-files/  # Proma 托管的项目根
│       ├── mcp.json
│       ├── skills/           # 启用中的 Skill
│       ├── skills-inactive/  # 已禁用的 Skill
│       ├── CLAUDE.md
│       └── .claude/memory/   # Auto Memory
├── automations.json
├── attachments/
├── default-skills/
├── settings.json
├── user-profile.json
└── sdk-config/
```

不用数据库，全是文件，方便备份和迁移。

## 技术栈

| 层级      | 选型                                                                 |
| ------- | ------------------------------------------------------------------ |
| 运行时与包管理 | Bun workspace monorepo                                             |
| 桌面框架    | Electron 43 + electron-builder                                     |
| 前端      | React 18、TypeScript、Vite、esbuild                                   |
| 状态管理    | Jotai                                                              |
| 样式与组件   | Tailwind CSS、Radix UI                                              |
| 输入与渲染   | TipTap、react-markdown、mermaid、KaTeX、Shiki                          |
| Agent   | Pi Agent SDK（`pi-coding-agent` / `pi-agent-core` / `pi-ai` 0.85.1） |

## 版权与许可

- 原始代码：Copyright © 2024-2026 Erlich Liu 及 Proma 贡献者，来自上游 [Proma](https://github.com/ErlichLiu/Proma)。
- 本仓库（Proma Dai）的修改：Copyright © 2026 wykwey。
- 许可证：沿用上游的 [GNU Affero General Public License v3.0](./LICENSE)。

AGPL-3.0 的要点：分发源码或修改后的版本、或通过网络对外提供服务时，需要公开完整的修改源码；衍生作品也要继续以 AGPL-3.0 授权。

商业使用：AGPL-3.0 允许商业使用，前提是遵守上述义务。豁免 AGPL-3.0 义务的双重授权只能由上游作者授予，本仓库不提供、也不代表上游。

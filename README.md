# dsh-git-heatmap

把本机多个 git 仓库的提交，渲染成 GitHub 风格的 53×7 贡献热力图，作为 DeepSeek Harness Web GUI 里的一个独立面板。

> 当前阶段：**M1（可安装空壳）**。侧栏入口与整页已通，M0 的「宿主进程能否 spawn git」探针已内置在页面顶部；数据层（仓库发现 / 身份过滤 / 按日聚合）在 M2 接入。

## 为什么是一个插件

- 浏览器跑不了 git，所以必须由一个 host 半在宿主进程里执行 `git`，浏览器半只读路由返回的 JSON。
- 分布式版本控制的提交散落在一台机器的几十个仓库里，GitHub 只覆盖其中一小部分（本机实测 34 个仓库里只有 5 个在 GitHub），且只统计默认分支 + 绑定邮箱的提交。
- 已有工具（`oh-my-gitstats`、`git-stats`、`heatgit` 等）都输出独立 HTML 或终端图，进不了 Harness 界面。

## 结构

```
package.json        双面插件 manifest（exports "." → host，"./client" → 浏览器）
cordis.patch.yml    一行 insert，把这一行挂进 profile 的 bundle 列表
icon.svg            面板图标（原创，简单几何热力块）
locale/{zh,en}.json 插件卡片标题与描述
lib/index.js        host 半：/git-heat/* 路由 + 受管子进程跑 git
lib/client.js       浏览器半：sidebar.panellist 图标 + main 整页
```

**没有构建链**：`lib/*.js` 就是发布产物。host 半是普通 ESM（只用 `node:` 内建，零运行时依赖）；浏览器半是 Harness 的模块加载器工厂格式（`window.__ModuleLoader__.load({ id, factory })`），用 `React.createElement` 而不是 JSX，所以不需要 tsc/tsdown。

## 接口

| 路由 | 说明 |
|---|---|
| `POST git-heat/config` | 静态配置视图：扫描根、身份别名、时区、周数、数据层状态 |
| `POST git-heat/probe` | M0 探针：在宿主进程里跑 `git --version`，返回是否成功、版本、耗时、argv[0]、cwd、stderr |

客户端调用一律用**文档相对路径**（`fetch('git-heat/probe')`，无前导 `/`）：GUI 以 `<base href="./">` 提供，根绝对路径会逃出子路径部署前缀。

## 安装

```bash
# 在本仓库目录下
dsh plugin --profile desktop add link:"$(pwd)"
```

或用 Harness 自己的 `plugin_manager`（`action: install_bundle`，`target` 传本目录绝对路径）。安装后刷新页面，左侧栏应出现「Git 热力图」入口。

## 设计约束（不要改坏）

- **路由前缀是 `/git-heat`**：`/git`（prefix）与 `/git/events`（exact）已被 `@linxin666/dsh-client-ui-git-graph` 占用。
- **Windows 上必须用 `git.exe`**：`.cmd` shim 无法被无 shell 的 spawn 启动，走 `cmd.exe` 又会展开 `--format=%H` 里的 `%`。
- **子进程要钉 `LC_ALL=C`**：否则 zh_CN 宿主上 git 的错误信息变成中文，错误分类全部失效。
- **两处注册都要走 `slots.inject`**：裸 `register` 在没声明该席位的 shell 上会抛错，表现为「插件没有激活」。
- **侧栏图标必须带 `data-dsh-panel-entry={PANEL_ID}`**：皮肤层（含 better-sidebar）靠这个语义锚点识别面板归属。
- **颜色只走 `--dsw-*` 变量**：深浅色由 `body[data-ds-dark-theme]` 决定，不要用 JS 分支判断主题。

## 与 `dsh-better-sidebar` 共存

本 profile 同时装着 `dsh-better-sidebar`。有据可查的结论（见 `research/04-sidebar-adapt.md`）：

- 它**不碰左侧栏**：自己挂一个 `position:fixed; pointer-events:none` 的浮层到 `document.body`，只渲染「底部工作台」；`sidebar.panellist` 与 `main` 两个席位在它源码里 **0 命中**，也没有任何官方 slot 替换。
- 它确实维护一份「面板 id → 图标」注册表（`TabDescriptor`），但下游只有**右侧栏 tab** 与**底部工作台**——往那张表里注册永远不会变成左侧栏图标。左侧栏只有 `panellist` 一条路。
- 它不读 `data-dsh-panel-entry`（全包 0 命中），所以本插件带这个属性只是给皮肤层用，与它无关。
- **唯一真实交叠**是中列高度：它给中列打 `margin-bottom: var(--dsh-sidebar-height)`，底部工作台展开时整页会被压缩（不是遮挡）。对策只有一条——页面根容器 `min-height: 0` + 自己滚动，已落在 `.ghm-page` 上。

因此**不需要**往它的 slot 注册、不需要 `inject: 'betterSidebar'`、也不需要在它的设置页里配置任何东西。

## 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 宿主进程 spawn git 探针 | ✅ 已实现，待装机验证 |
| M1 | 可安装空壳：侧栏入口 + 整页 + 路由 | ✅ 已实现，待装机验证 |
| M2 | 数据层：仓库发现 + 身份过滤 + 按日聚合（`/git-heat/heat`） | ⏳ |
| M3 | 网格上屏：真实数据 + 色阶 + tooltip | ⏳ |
| M4 | 交互：时间窗切换、仓库过滤（过滤后重算阈值）、单日提交列表 | ⏳ |

## 相关研究

设计依据见上级目录：

- `GIT-HEATMAP-插件-综合研究与施工方案.md` —— 主稿（口径决策、架构、数据模型、施工计划）
- `research/01-plugin-api.md` —— 插件架构实证（host 路由 / slot 注册 / 安全三层）
- `research/02-git-data.md` —— 数据层实测（34 仓库 23933 提交、去重、身份归一）
- `research/03-ui-grid.md` —— 渲染层（53×7 算法、色阶、组件树）

## 许可

Apache-2.0

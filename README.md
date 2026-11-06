# dsh-git-heatmap

在 [DeepSeek Harness](https://github.com) 的 Web GUI 里，把本机多个 git 仓库的提交渲染成 GitHub 风格的 53×7 贡献热力图。

针对的是一个 GitHub 覆盖不到的场景：代码散落在一台机器的几十个仓库里，托管平台各不相同（GitHub / Gitee / 自建 GitLab / codeup），把「我今年到底写了多少」做成一目了然的格子。

> 早期版本（v0.1.x），接口与配置项可能变动。

## 功能

- **多仓库聚合**：递归扫描配置的目录，发现所有 git 仓库，合并成一张图
- **只算本人**：按 author email 认领提交，避免把 fork/上游历史算成自己的
- **时间窗**：53 / 26 / 12 周、全部历史、自定义区间
- **仓库过滤**：勾选任意仓库组合，色阶按过滤后的分布重算
- **可读的交互**：hover 看当天明细（本地/远程分别计数）、点击看当天提交列表、深浅色主题自动适配
- **远程贡献**：把 GitHub / Gitee 上的贡献合并进同一张网格（可选）
- **可配置外观**：品牌色 / GitHub 绿 / 自定义四色，色阶可按分位自适应或按绝对值固定
- **全部在页面内设置**，不需要编辑配置文件

## 安装

需要已安装 DSH，且版本 ≥ `0.2.1-rc.3`。

```bash
git clone https://github.com/senmoxiu/dsh-git-heatmap.git
cd dsh-git-heatmap
dsh plugin --profile <你的 profile 名> add link:"$(pwd)"
```

也可以让 Harness 自己的 `plugin_manager` 安装：`action: install_bundle`，`target` 传本目录绝对路径。

装完刷新页面，左侧栏出现「Git 热力图」图标，点开是整页。

## 首次使用

插件**不带任何预设**——没有内置路径，也没有内置邮箱。所以刚装上是空的，页面顶部会提示去配置。

打开页面右上「设置」，至少填两项：

| 项 | 说明 |
|---|---|
| **扫描根** | 一行一个目录，插件在这些目录下递归找 git 仓库（深度 6 层，自动跳过 `node_modules` 等） |
| **邮箱别名** | 你提交时用的 author email，一行一个。**只统计命中的邮箱** |

填完点「保存并刷新」即可。这两项也是权限边界：不在扫描根里的目录不会被读取，扫描只读不写。

## GitHub / Gitee 远程贡献（可选）

在设置页填用户名与令牌并勾选「启用」，托管平台上的贡献会合并进同一张网格。

**令牌存在哪**：优先环境变量（GitHub：`GITHUB_TOKEN` / `GH_TOKEN`，Gitee：`GITEE_TOKEN`）；没有则读 `$DSH_HOME/git-heatmap.secrets.json`（面板里填的令牌就写在这里，权限 `0600`）。令牌不会出现在任何接口响应或日志里，配置视图只回一个「已设置」布尔值。

|  | 有令牌 | 无令牌 |
|---|---|---|
| GitHub | GraphQL `contributionsCollection`，精确日历，含私有仓库 | 公开事件流：约 90 天、最多 300 条，**按 push 计数**（GitHub 已不在 PushEvent 里带提交数） |
| Gitee | `/users/{login}/events` | `/users/{login}/events/public`：最近 100 条，容易触发限流 |

长度限制带来两个已知偏差，页面上会以告警形式显示：GitHub 的接口单次最长 1 年（本插件按年切分后并发请求再合并）；Gitee 的匿名事件流不支持翻页。

某个来源不可用（未配置 / 限流 / 用户不存在）只会变成状态行里的一行提示，不影响本地统计。

## 统计口径

- **按邮箱认领**：author email 必须命中别名表。一台真实机器上 23,933 条提交里只有 694 条属于本人——不筛的话 97% 的格子是别人的。
- **全分支 + 全局去重**：`git log --all` 天然按 SHA 去重。不要逐分支相加：某 8 分支仓库逐分支加总 5,793 条，`--all` 只有 856 条。
- **归日按配置时区**：只认 `%at`（epoch 秒）再按 `Asia/Shanghai` 之类的时区换算，不解析 `%aI` 自带的偏移（部分提交以 `Z` 结尾会算错）。
- **口径收敛到网格窗口**：卡片上的「总提交 / 活跃天数 / 最长连续 / 最忙一天」只算当前窗口内，否则数字会对不上格子里数出来的；全时段数字另存于 `stats.allTime`。
- **不做增量**：几十个仓库全量重扫约 1.5–2 秒，增量每次进程启动就要 ~90 ms，是负优化。结果缓存 5 分钟。

## 数据与隐私

- 所有 git 读取都在本机宿主进程内完成，仓库路径、提交信息**不会上传**
- 远程贡献只在启用后请求对应平台，且只取「某用户某区间的每日贡献计数」
- 扫描根之外的目录不会被读取
- 令牌只进内存与本地 secrets 文件，不写日志、不回显

## 已知限制

- **Gitee 覆盖不完整**：匿名接口只给最近 100 条事件且不支持翻页，更早的日期会缺失
- **GitHub 无令牌时数字偏小**：公开事件流按 push 计，不等于提交数，且只覆盖约 90 天
- **Windows 依赖 `git.exe`**：`.cmd` shim 无法被无 shell 的 spawn 启动，见下方开发说明
- 早期版本，未做 i18n（界面文案中文，插件卡片标题与描述提供中英两份）

## 开发

**没有构建链**：`lib/*.js` 就是发布产物。

```
package.json        双面插件 manifest（exports "." → host，"./client" → 浏览器）
cordis.patch.yml    一行 insert，挂进 profile 的 bundle 列表
lib/index.js        host 半：/git-heat/* 路由 + 受管子进程跑 git
lib/remotes.js      远程适配器：GitHub GraphQL / Gitee events（按 mtime 热重载）
lib/client.js       浏览器半：侧栏图标 + 整页（React.createElement，非 JSX）
locale/{zh,en}.json 插件卡片标题与描述
```

host 半是普通 ESM，只用 `node:` 内建，零运行时依赖；浏览器半是 Harness 的模块加载器工厂格式（`window.__ModuleLoader__.load({ id, factory })`）。

### 接口

| 路由 | 说明 |
|---|---|
| `POST git-heat/heat` | 热力图模型：仓库清单 + 按日聚合 + 本人提交列表；`{"refresh":true}` 绕过缓存 |
| `POST git-heat/config` | 当前生效配置（不含令牌） |
| `POST git-heat/config/save` | 局部写入配置；字段级校验，非法字段忽略并保留原值 |
| `POST git-heat/probe` | 在宿主进程里跑 `git --version`，用于排查 git 不可用 |
| `POST git-heat/remote` | 远程源探针：每个平台「未配置 / 令牌无效 / 可用」及告警 |

### 改动时注意

- **路由前缀是 `/git-heat`**：不要用 `/git`，会和 git-graph 类插件冲突
- **两处 UI 注册都要走 `slots.inject`**：裸 `register` 在没声明该席位的 shell 上会抛错，表现为「插件没有激活」
- **侧栏图标带 `data-dsh-panel-entry`**：皮肤层靠这个语义锚点识别面板归属
- **Windows 上必须写 `git.exe`**，且子进程要钉 `LC_ALL=C`（否则 zh_CN 宿主上 git 报错变中文，错误分类失效）
- **颜色只用 `--dsw-*` 变量**：深浅色由 `body[data-ds-dark-theme]` 决定，不要用 JS 判断主题

## 许可

[Apache-2.0](LICENSE)

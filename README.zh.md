# dsh-gh-pages-artifacts

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件，让 Agent（智能体）将**产物（artifact）**，即 HTML 页面和 Markdown 文档，以可分享链接的形式发布到 **GitHub Pages**。

它的目标是在 dsh 中直接替代 Claude 的 Artifacts 以及 Codex 桌面版的站点（site）功能。

让 Agent 把报告、仪表盘、图表或文章“做成页面”。它会写好文件并发布，然后回复一个类似 `https://you.github.io/dsh-artifacts/q3-report-k3x9ab/` 的链接。之后它可以原地更新同一个产物，链接始终不变。它还可以列出、读回和删除产物。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/artifacts-panel-dark.png">
  <img alt="dsh 侧边栏中的 Artifacts 面板，列出已发布的页面及其链接" src="docs/images/artifacts-panel-light.png">
</picture>

> **已发布的产物是公开的。** 任何拿到链接的人都能访问 GitHub Pages 站点。在 GitHub Free 上，仓库本身也必须公开，而且即使删除之后，git 历史仍会保留旧版本。插件会在发布或删除前询问（*完全权限*会话除外，见[行为细节](#行为细节)），添加 `noindex`，并拒绝隐藏文件和疑似凭据的内容，但分享什么由你决定。

## 效果展示

每个产物都是 GitHub Pages 上的一个普通页面。下面这个仪表盘就是 Agent 自己编写并发布的：

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/published-page-dark.png">
  <img alt="Agent 发布到 GitHub Pages 的销售仪表盘" src="docs/images/published-page-light.png">
</picture>

从 Artifacts（产物）面板中删除时，会直接在该行内请求确认：

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/artifacts-delete-dark.png">
  <img alt="删除产物前的行内确认" src="docs/images/artifacts-delete-light.png">
</picture>

本插件在**插件**下有自己的页面，其中包含它的设置：

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/settings-dark.png">
  <img alt="插件设置页：GitHub token、仓库策略、提交和安全选项" src="docs/images/settings-light.png">
</picture>

## Agent 获得的能力

| 工具 | 作用 | 需审批 |
|---|---|---|
| `artifact_publish` | 从工作区文件（`path`）或内联 `content` 创建产物，或原地更新已有产物（`id`）。Markdown 会渲染成带浅色和深色主题的简洁页面；HTML 按原样提供。额外文件（图片、CSS、JS、数据）放在 `assets` 中。 | 是 |
| `artifact_list` | 按从新到旧列出产物，包含 id、标题和 URL；可用 `query` 筛选。 | 否 |
| `artifact_read` | 分段读取产物的源码（或它的其他文本文件）。 | 否 |
| `artifact_delete` | 删除产物。它的 id 永不复用，因此旧链接不会显示新内容。 | 是 |
| `artifact_status` | 诊断配置（token、仓库、Pages 设置），并检查某次部署或某个产物是否已上线。 | 否 |
| `artifact_repository` | 查看或更改新产物的发布位置：关联已有仓库（`owner/name` 或远程 URL）、取消关联，或在 shared 与 per-artifact 策略之间切换。 | 否 |

插件还会添加：

- 一小段系统提示词，让模型知道何时使用这些工具；以及
- 内置的 `artifact-pages` 技能，提供页面设计指导。用户可以通过 `/artifact-pages` 调用它；`~/.dsh/skills` 或项目中的同名技能会覆盖它。

## 仓库策略

- **`shared`**（默认）：所有产物都放在同一个仓库中，每个产物一个文件夹，地址为 `https://<owner>.github.io/<repo>/<id>/`。使用哪个仓库按以下优先级依次确定：你在运行时**关联**的仓库（*“把我的产物发布到 github.com/me/team-pages”*，Agent 会通过 `artifact_repository` 的 `link` 完成关联）、`repository` 选项（`owner/name` 或远程 URL，例如 `git@github.com:me/team-pages.git`），或 `owner`/`repo`。
- **`per-artifact`**：每个新产物都有一个独立的**新仓库** `<owner>/<repoPrefix><id>`（默认为 `artifact-<id>`），地址为 `https://<owner>.github.io/artifact-<id>/`。插件会创建该仓库，把页面发布到仓库根目录，开启 GitHub Pages，为仓库加上 `dsh-artifact` 话题，并把页面 URL 设为仓库主页。这需要一个有权创建仓库的 token（见 token 一节）。

可以在插件设置页、通过 `repoStrategy` 选项或在对话中（*“从现在起，把每个产物放进单独的仓库”*）设置策略。在对话中做出的选择会保存到同一份设置中，因此设置页和你的 profile 文件始终显示当前生效的值。（如果没有 dsh 的设置服务，例如在自定义组合中，该选择会改为保存在注册表（registry）中，并覆盖配置。）已有产物始终留在发布时的位置；更新、读取和删除操作通过注册表找到它们。

## 追踪已发布的内容

点击 dsh 侧边栏（Web 和 Desktop）中的 **Artifacts**，即可按从新到旧查看所有已发布的页面和文档。每个条目显示标题、链接、描述、仓库和最后更新时间。链接会在新的浏览器标签页中打开（在 Desktop 上则在默认浏览器中打开）。**Refresh**（刷新）还会在 GitHub 上查找从其他机器发布的产物。要删除某个产物，把鼠标悬停在它所在的行上，点击垃圾桶图标并确认。插件会提交一个 commit，从仓库中移除它的文件，并将其 id 标记为已删除（tombstone）；GitHub Pages 重新部署后（通常在一分钟内），该页面会返回 404。由于是你亲自在面板中确认的，这里不会再弹出 Agent 审批提示。

每次发布、更新和删除都会记录在本地注册表 `$DSH_HOME/gh-pages-artifacts/registry.json`（选项 `registryDir`）中。它旁边的 `index.html` 列出所有产物，包括指向其页面和仓库的**可点击链接**、类型、修订版本、最后更新时间，以及它当前是已上线还是已删除。`artifact_list` 以 Markdown 链接的形式返回同样的列表，涵盖所有仓库和策略，并补充它在共享仓库中发现的、由其他机器发布的产物。可以问 *“你发布过哪些内容？”* 或 *“给我看产物索引”*（Agent 可以在侧边面板中展示索引页）。

## 工作原理

- **内容存放在仓库中。** 每个产物位于 Pages 分支上自己的文件夹中（使用 per-artifact 策略时则位于其独立仓库的根目录）（`<id>/index.html`，Markdown 产物另有 `source.md`，以及所有资源文件）。分支根目录下的清单文件 `.dsh-artifacts.json` 记录 id、标题、描述、类型、修订版本和时间戳。使用 `siteDir: ''`（默认值）时，清单文件也会被公开提供，因此任何知道站点 URL 的人都能列出所有产物。若不想公开这份列表，请从 `/docs` 发布（`siteDir: docs`）。
- **每次变更都是一个原子 commit。** commit 通过 Git Data API 构建（blobs → tree → commit），并以仅快进（fast-forward-only）的 ref 更新来应用。如果有其他写入方（另一个 dsh 窗口、另一台机器）更新了该分支，变更会基于新的 head 重新构建并重试。不会丢失任何内容，也不会强制推送。
- **`.nojekyll`** 会被提交到仓库，使 Pages 原样提供写入的文件。插件拒绝写入已有的 Jekyll 站点（含 `_config.yml` 且没有 `.nojekyll` 的站点），也无法发布到受保护分支。
- **URL** 的格式为 `<site>/<pathPrefix>/<id>/`。站点 URL 来自 Pages API，它能正确处理自定义域名；设置 `baseUrl` 可以覆盖它。id 由标题生成的 slug 加随机后缀组成（`q3-report-k3x9ab`），也可以使用你指定的 `slug`。
- **Pages 缓存：** 变更通常在一分钟内生效。浏览器可能会继续显示旧版本，最长达 10 分钟。

## 环境要求

- DeepSeek Harness **0.2.0-rc.2 或更新版本，且在 0.2.x 范围内**（Web、Desktop 或 CLI）。
- 一个 GitHub 账号，以及一个已启用 GitHub Pages 的仓库（下面的 setup 命令会替你完成）。
- 一个仅对该仓库拥有 **Contents: read and write** 权限（最好再加上 **Pages: read-only**）的 GitHub token。per-artifact 策略则需要一个有权创建仓库的 token（见下文）。

## 安装配置

### 1. 创建仓库并启用 Pages

请在本仓库的 checkout 目录中，自己在终端里运行以下命令（不要通过 Agent 运行），并确保 [GitHub CLI](https://cli.github.com) 已登录（`gh auth login`）：

```bash
node bin/setup.mjs setup --author "Your Name <you@example.com>"
```

它会在你的账号下创建一个**公开**仓库 `dsh-artifacts`（会先询问），创建 `gh-pages` 分支，并从该分支启用 GitHub Pages。`--author` 设置该命令所创建 commit 的作者；不设置时 GitHub 使用你账号的身份。其他选项：`--owner <org>`、`--repo <name>`、`--branch <name>`、`--docs`（从 `/docs` 发布）、`--private`（仅限付费套餐；隐含 `--docs`；页面仍是公开的）以及 `--yes`。等该包发布到 npm 后，`npx dsh-gh-pages-artifacts setup` 也能完成同样的操作。

如果想手动完成：

1. 创建一个仓库，例如 `dsh-artifacts`。**不要**使用你的 `<you>.github.io` 站点仓库，因为产物会与该站点共用根目录。
2. 在 **Settings → Pages** 中选择 **Deploy from a branch**，然后选择分支 `gh-pages` 和文件夹 `/ (root)`。如果分支尚不存在，插件会在首次发布时创建它；推送 `gh-pages` 分支通常会自动启用 Pages。

### 2. 创建 token

创建一个[细粒度个人访问 token](https://github.com/settings/personal-access-tokens/new)（fine-grained personal access token）：

- **Repository access**：Only select repositories → 你的产物仓库
- **Permissions**：
  - **Contents**：Read and write（必需）
  - **Pages**：Read-only（推荐；让 `artifact_status` 能验证 Pages 设置和部署，并让插件能发现自定义域名）

带 `public_repo` scope 的 classic token 也可以使用，但授予的权限要大得多。避免复用 `gh auth token`：它带有你的 CLI 的全部 scope。

对于 **per-artifact** 策略，token 必须能创建仓库并开启 Pages：可以是 **Repository access: All repositories** 且 **Administration**、**Contents**、**Pages** 均设为 *Read and write* 的细粒度 token，也可以是带 `public_repo`（私有仓库则为 `repo`）的 classic token。

### 3. 把 token 提供给 dsh

插件读取由 `tokenEnv` 指定名称的凭据（默认 **`GH_PAGES_TOKEN`**）。它绝不会从对话中获取 token。**切勿把 token 粘贴到对话中。** 可使用以下任一来源（按优先级从高到低排列）：

1. 启动 dsh 的进程的**环境变量**：`export GH_PAGES_TOKEN=github_pat_...`。macOS 和 Linux 上的 Desktop 会在启动时导入登录 shell 中 export 的变量，因此修改后需要重启应用。
2. **`$DSH_HOME/.credentials.yaml`**（默认 `~/.dsh/.credentials.yaml`）。该文件支持热重载，且权限必须为 `chmod 600`：

   ```yaml
   version: 1
   refs:
     GH_PAGES_TOKEN: github_pat_...
   ```

   如果文件已存在，请把这个键添加到现有的 `refs:` 下。不要再添加第二个 `refs:`。
3. 启动 dsh 时所在目录中的 `.env`。它只在启动时读取一次，因此编辑后需要重启。如果 token 来自这里，插件要求设置 `owner` 选项，这样某个仓库自带的 `.env` 就无法悄悄把你的发布重定向到别人的账号。
4. `$DSH_HOME/.env`。同样在启动时读取，因此编辑后需要重启。

来自环境变量的值优先，且为只读。名称形似 token 的变量（含 `TOKEN`）会从 Agent 运行的 shell 命令中清除。不过，Agent 的进程以你的操作系统用户身份运行，因此请把这看作一种审慎措施，而不是安全边界。

### 4. 安装插件

**从最新 release 安装**（推荐；已预构建，不会在你的机器上执行构建）：

```bash
dsh plugin --profile web add https://github.com/opdsh/dsh-gh-pages-artifacts/releases/latest/download/dsh-gh-pages-artifacts.tgz
```

在 **Desktop / Web** 中，打开**插件 → 添加插件**并输入同一个 URL。安装后，请重启正在运行的 CLI profile。

**从 GitHub 源码安装。** 该包会在安装时自行构建，因此在你允许该构建之前，pnpm 会阻止第一次安装：

```bash
dsh plugin --profile web add github:opdsh/dsh-gh-pages-artifacts
```

随后 dsh 会打印一个类似 `dsh-gh-pages-artifacts@https://codeload.github.com/opdsh/dsh-gh-pages-artifacts/tar.gz/<commit>` 的键。把它加上 `: true`，写到该 profile 的 `pnpm-workspace.yaml` 中的 `allowBuilds:` 下（dsh 会打印该文件路径），然后再次运行命令。这个键对应某一个 commit，因此更新后需要重新允许。

**从本地 checkout 安装。** 需要先构建（`lib/` 没有提交到仓库）：

```bash
git clone https://github.com/opdsh/dsh-gh-pages-artifacts.git
```

```bash
cd dsh-gh-pages-artifacts && pnpm install && pnpm run build
```

```bash
dsh plugin --profile web add "$PWD"
```

### 5. 配置（可选）

打开**插件 → GitHub Pages Artifacts**。插件页面中包含以下设置：

- **GitHub token**：是否已配置 token，以及一个把 token 保存到 dsh 凭据存储的输入框（token 来自环境变量时不可用）
- **Where artifacts are published**（产物发布位置）：策略、共享仓库（`owner/name` 或远程 URL）、新仓库的所有者、前缀和可见性，以及 Pages 分支
- **Commits**（提交）：作者名称和邮箱
- **Safety**（安全）：审批、`noindex` 和敏感信息拦截

更改无需重启，会在下一次发布时生效，并保存到你的 profile 的 `cordis.patch.yml` 中。

你也可以直接编辑该文件。如果仓库是 token 所属用户名下的 `dsh-artifacts`，且 Pages 从 `gh-pages` 分支的根目录发布，默认值即可直接使用；否则请添加类似下面这样的一行：

- CLI：`~/.dsh/profiles/<profile>/cordis.patch.yml`
- Desktop：**设置 → 打开配置文件**

```yaml
- id: gh-pages-artifacts
  config:
    owner: your-login-or-org
    repo: dsh-artifacts
```

patch 会替换该行的整个 `config`，你省略的键会使用默认值。可以用 `dsh --profile web --dump-config` 检查组合后的结果。在 Web 和 Desktop 应用中，更改会实时重新加载。

然后对 Agent 说：*“为这个仓库的架构写一页摘要并发布。”* 如果有任何异常，让它运行 `artifact_status`。

## 配置参考

| 选项 | 默认值 | 含义 |
|---|---|---|
| `owner` | token 所属用户 | 拥有该仓库的用户或组织。 |
| `repo` | `dsh-artifacts` | 托管产物的仓库。 |
| `repository` | 无 | 共享仓库，格式为 `owner/name` 或远程 URL（`https://github.com/owner/name.git`、`git@github.com:owner/name.git`）；对共享仓库而言会覆盖 `owner`/`repo`。运行时关联的仓库会覆盖此项。 |
| `repoStrategy` | `shared` | `shared`（单个仓库）或 `per-artifact`（每个新产物一个新仓库）。运行时的选择会覆盖此项。 |
| `repoPrefix` | `artifact-` | per-artifact 策略所创建仓库的名称前缀。 |
| `repoVisibility` | `public` | per-artifact 策略所创建仓库的可见性。在私有仓库上使用 Pages 需要付费套餐；无论哪种情况，页面都是公开的。 |
| `registryDir` | `$DSH_HOME/gh-pages-artifacts` | 存放本地注册表及其 `index.html` 的文件夹。 |
| `branch` | `gh-pages` | Pages 发布所用的分支。不存在时会在首次发布时创建。 |
| `siteDir` | `''` | Pages 源文件夹：`''`（根目录）或 `docs`。 |
| `pathPrefix` | `''` | 站点根目录下存放产物的文件夹，例如 `a` → `<site>/a/<id>/`。 |
| `baseUrl` | 来自 Pages API | 公开的站点 URL。使用自定义域名且 token 缺少 Pages 读取权限时，请设置此项；在 GitHub Enterprise Server 上也请设置（在那里，除非 token 能读取 Pages，否则必须设置）。 |
| `tokenEnv` | `GH_PAGES_TOKEN` | 存放 token 的凭据引用（环境变量名）。 |
| `apiBaseUrl` | `https://api.github.com` | REST API 基础地址；仅在使用 GitHub Enterprise Server 时修改。 |
| `approval` | `unless-full-access` | `unless-full-access`：发布和删除前询问，*完全权限*会话（danger-full-access 沙箱且关闭审批提示）除外。`always`：始终询问。`off`：从不询问。 |
| `hideFromPresets` | `['minimal']` | 不提供产物工具的 Agent 模式。 |
| `subagentAccess` | `read-only` | 被委派的子智能体：`read-only`（列出、读取、查看状态）、`full` 或 `none`。 |
| `noindex` | `true` | 为页面添加 `<meta name="robots" content="noindex, nofollow">`，即使页面要求被索引也会添加。 |
| `csp` | `object-src 'none'; base-uri 'none'` | 添加到页面的 Content-Security-Policy meta 标签；设为 `''` 可禁用。 |
| `blockSecrets` | `true` | 拒绝隐藏文件和凭据文件（`.env`、密钥、`.ssh/` 等），以及任何疑似凭据的标题、描述、页面或资源文件（GitHub/AWS/Slack/npm/API 密钥、JWT、私钥、URL 或赋值语句中的密码、以任何常见编码出现的已配置 token）。 |
| `maxPublishBytes` | `10485760` | 单次发布的最大总字节数（页面加资源文件）。 |
| `commitAuthor` | token 所属用户 | 用作 commit 作者和提交者的 `{ name, email }`。 |
| `promptGuidance` | `true` | 添加那一小段系统提示词。 |
| `bundledSkill` | `true` | 注册 `artifact-pages` 技能。 |

## 行为细节

- **审批。** 发布、更新和删除都会通过 dsh 的审批面板请求确认。提示首先显示确切的 URL，并列出源文件（或内联内容的大小）、以 `source → published name` 形式列出的每个资源文件、被移除的资源文件以及总大小。标题会加引号显示，且不得包含控制字符或双向（bidi）字符，因此无法用标题来伪装请求。在默认的 `unless-full-access` 下，只有*完全权限*会话可以不经提示直接发布；*Auto review* 会话仍会被询问。没有审批通道的 headless 运行和 SDK 会话会默认拒绝（fail closed），除非你设置 `approval: off`。子智能体无法请求审批，因此默认只获得只读工具；这一限制在工具运行时强制执行，而不只是靠隐藏工具。
- **限定在工作区内。** `path` 和 `assets` 必须是会话工作目录内的普通文件。符号链接、目录、解析后位于工作目录之外的路径、隐藏文件以及疑似凭据的文件都会被拒绝。页面本身必须是 `.html`、`.htm`、`.md`、`.markdown` 或 `.txt`。这能挡住各种路径花招，但无法阻止 Agent 把数据复制到工作区或以内联方式传入。真正的把关仍然是审批提示和你自己。
- **Markdown** 按 GitHub-flavored Markdown 渲染（表格、任务列表、脚注、删除线、自动链接）。Markdown 中的原始 HTML 会被转义，`javascript:` 链接会被丢弃。需要交互的内容请发布为 HTML。
- **HTML** 按原样发布。HTML 片段会被包装成完整文档。插件只会紧接在 `<head>` 之后插入 robots 和 CSP 两个 meta 标签，并用 `data-dsh-artifacts` 标记，因此 `artifact_read` 返回的页面不含它们。内联 `content` 只有在是完整文档（`<!doctype html>` 或 `<html>`）时才视为 HTML；其他内容一律按 Markdown 渲染。
- **更新**会替换页面，保留你未提及的资源文件，并移除 `removeAssets` 中列出的资源文件。传入 `baseRev` 后，如果在你读取之后有其他人修改过该产物，更新会被拒绝。
- **删除**会从分支 head 中移除文件，并将该 id 标记为已删除（tombstone）。内容仍保留在 git 历史中，保存过副本的人也仍持有该副本。
- **状态。** `artifact_status` 会将最新的 Pages 构建与分支 head 进行比较，因此“deployed”表示你最新的变更已上线。设置 `wait: true` 时，它最多等待五分钟。实际部署通常需要一到三分钟。
- **源隔离。** 同一所有者的所有项目站点共享 `https://<owner>.github.io` 这个源（cookie、localStorage）。如果你在该源上运行其他应用，请考虑为产物使用单独的账号或组织，或自定义域名。

## 开发

推送一个与 `package.json` 相符的 tag（例如 `v0.1.0`）即可发布新版本；release 工作流会运行测试、构建，并把 `dsh-gh-pages-artifacts.tgz` 附加到 GitHub Release。

```bash
pnpm install
pnpm run typecheck
pnpm test          # unit, integration (real dsh tool/approval/fs/skill services), and setup-script tests against an in-memory GitHub
pnpm run build     # emits lib/
```

如果想不安装就试用本地 checkout，可以用 overlay patch 运行 dsh：

```yaml
# dev.patch.yml
- insert:
    - id: gh-pages-artifacts
      name: /absolute/path/to/gh-pages-plugin/lib/index.js
      config:
        owner: your-login
```

```bash
dsh web --patch ./dev.patch.yml
```

## 许可证

MIT

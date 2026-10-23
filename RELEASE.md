# 发布清单

插件 ID / npm 包名：`dsh-model-session-headers`（官方源未占用）。

## 一键发布（推荐）

先把仓库推到 GitHub，剩下的交给脚本：

```bash
gh auth login                 # 只需一次
./scripts/publish.sh --owner <你的GitHub用户名或组织>          # 预演，只打印命令
./scripts/publish.sh --owner <你的GitHub用户名或组织> --yes    # 真正执行
```

脚本按顺序做：

1. 写入 `package.json` 的 `repository` / `homepage` / `bugs`，并把 README 里的 `github:<you>` 换成真实地址；
2. `git init`（如需要）+ 提交；
3. `gh repo create --public --push`；
4. 加 topic：`dsh-plugin`、`dsh`、`deepseek-harness`、`cordis-plugin`、`llm-gateway`；
5. 打 tag `v0.1.0` 并推送，触发 CI 发布。

## 手动步骤（等价）

```bash
npm pkg set repository.type=git \
  repository.url=git+https://github.com/<owner>/dsh-model-session-headers.git \
  homepage=https://github.com/<owner>/dsh-model-session-headers#readme \
  bugs.url=https://github.com/<owner>/dsh-model-session-headers/issues

git init -b main && git add -A && git commit -m "release: v0.1.0"
gh repo create <owner>/dsh-model-session-headers --public --source=. --remote=origin --push
gh repo edit --add-topic dsh-plugin --add-topic dsh --add-topic deepseek-harness
git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0
```

## npm 发布

CI 方式：在仓库 Secrets 里加 `NPM_TOKEN`（npm → Access Tokens → Granular，读写该包）。之后每次推 `v*` tag，`.github/workflows/release.yml` 会跑测试 → `npm publish` → 生成 GitHub Release 并附 tarball。

本机方式：

```bash
npm login --registry=https://registry.npmjs.org
npm publish --access public --registry=https://registry.npmjs.org
```

> 若本机 `.npmrc` 指向镜像（如腾讯云），**必须显式带 `--registry`**，否则会往镜像发而失败。

## 插件市场收录

两条路，任选：

- **自动**：仓库带 `dsh-plugin` topic 后，市场爬虫会扫描收录，通常 ≤2 小时出现在「设置 → 插件市场」。
- **手动**：[dsh.so/submit](https://www.dsh.so/submit/) 粘贴仓库地址；或 [dsh-plugin.org](https://dsh-plugin.org/) 的提交页。校验项：`dsh` 字段、README 安装命令、SPDX license、仓库名 slug、可扫描源码、无硬编码密钥。

收录要求里最容易漏的两条，已满足：

- README 有可复制的安装命令（`dsh plugin --profile web add ...`）；
- 仓库有 `dsh-plugin` topic（脚本自动加）。

## 发布前自检

```bash
npm test                 # 16 个测试
npm pack --dry-run       # 只应包含 index.js / cordis.patch.yml / README / LICENSE / package.json
node -e "console.log(require('./package.json').dsh.bundle.patch)"   # ./cordis.patch.yml
```

## 版本升级

```bash
npm version patch        # 或 minor / major，生成 commit + tag
git push --follow-tags   # CI 自动发 npm + Release
```

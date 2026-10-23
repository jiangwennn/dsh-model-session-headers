#!/usr/bin/env bash
#
# Publish dsh-model-session-headers to GitHub (and optionally npm).
#
#   ./scripts/publish.sh --owner <github-user-or-org> [--repo <name>] [--npm] [--yes]
#
# Without --yes it prints every command and changes nothing.
# Requires: git, gh (logged in), and npm logged in for --npm.
#
set -euo pipefail

OWNER=""
REPO="dsh-model-session-headers"
DO_NPM=0
CONFIRM=0
NPM_REGISTRY="https://registry.npmjs.org"

while [ $# -gt 0 ]; do
  case "$1" in
    --owner) OWNER="${2:-}"; shift 2 ;;
    --repo)  REPO="${2:-}"; shift 2 ;;
    --npm)   DO_NPM=1; shift ;;
    --registry) NPM_REGISTRY="${2:-}"; shift 2 ;;
    --yes)   CONFIRM=1; shift ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
run() {
  printf '$ %s\n' "$*"
  if [ "$CONFIRM" -eq 1 ]; then
    "$@"
  fi
}

if [ -z "$OWNER" ]; then
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    OWNER="$(gh api user -q .login)"
  else
    echo "缺少 --owner，且 gh 未登录。先 gh auth login 或显式传 --owner。" >&2
    exit 2
  fi
fi

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
URL="https://github.com/${OWNER}/${REPO}"

say "插件 dsh-model-session-headers@${VERSION} → ${URL}"

if [ "$CONFIRM" -ne 1 ]; then
  echo "（dry-run：加 --yes 才会真正执行）"
fi

# 1. repository / homepage / bugs 指向真实仓库，npm 与插件市场都靠它取元数据。
say "写入仓库元数据"
run npm pkg set \
  "repository.type=git" \
  "repository.url=git+${URL}.git" \
  "homepage=${URL}#readme" \
  "bugs.url=${URL}/issues"

# README 里的安装命令必须和真实仓库一致，否则插件市场校验与用户复制都会失败。
say "把 README 的 <you> 替换为 ${OWNER}"
printf '$ node -e <replace github:<you> in README.md>\n'
if [ "$CONFIRM" -eq 1 ]; then
  node -e '
    const fs = require("node:fs")
    const owner = process.argv[1]
    const path = "README.md"
    const before = fs.readFileSync(path, "utf8")
    const after = before.replaceAll("github:<you>", `github:${owner}`)
    if (after !== before) fs.writeFileSync(path, after)
  ' "$OWNER"
fi

# 2. 本地提交（幂等：没有改动就跳过）。
if [ ! -d .git ]; then
  say "初始化 git 仓库"
  run git init -b main
fi
run git add -A
if ! git diff --cached --quiet 2>/dev/null; then
  run git -c user.name="${GIT_AUTHOR_NAME:-$OWNER}" \
          -c user.email="${GIT_AUTHOR_EMAIL:-${OWNER}@users.noreply.github.com}" \
          commit -m "release: v${VERSION}"
else
  echo "无待提交改动"
fi

# 3. 创建公开仓库并推送（已存在则只推）。
say "创建 / 推送 GitHub 仓库"
if [ "$CONFIRM" -eq 1 ] && gh repo view "${OWNER}/${REPO}" >/dev/null 2>&1; then
  run git remote get-url origin >/dev/null 2>&1 || run git remote add origin "${URL}.git"
  run git push -u origin main
else
  run gh repo create "${OWNER}/${REPO}" --public --source=. --remote=origin --push \
    --description "Per-model session-id headers for DeepSeek Harness: Claude Code (x-claude-code-session-id) / OpenCode Go (x-opencode-session)"
fi

# 4. topic 是插件市场爬虫的识别信号，缺了就不会被收录。
say "添加 topic（插件市场靠 dsh-plugin 识别）"
run gh repo edit "${OWNER}/${REPO}" \
  --add-topic dsh-plugin \
  --add-topic dsh \
  --add-topic deepseek-harness \
  --add-topic cordis-plugin \
  --add-topic llm-gateway

# 5. 打 tag 触发 .github/workflows/release.yml（npm publish + GitHub Release）。
say "打 tag ${TAG} 并推送（触发 CI 发布）"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "tag ${TAG} 已存在，跳过"
else
  run git tag -a "$TAG" -m "v${VERSION}"
fi
run git push origin "$TAG"

# 6. 可选：本机直接发 npm（CI 已配 NPM_TOKEN 时不需要）。
if [ "$DO_NPM" -eq 1 ]; then
  say "发布到 npm（${NPM_REGISTRY}）"
  run npm publish --access public --registry "$NPM_REGISTRY"
fi

say "完成"
cat <<EOF
仓库      ${URL}
安装      dsh plugin --profile web add github:${OWNER}/${REPO}
npm 安装  dsh plugin --profile web add dsh-model-session-headers   # 发布 npm 后可用
收录      仓库已带 dsh-plugin topic，插件市场爬虫会自动收录（通常 ≤2 小时）
手动提交  https://www.dsh.so/submit/  或  https://dsh-plugin.org/
EOF

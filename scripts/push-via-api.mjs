#!/usr/bin/env node
/**
 * Push the current working tree to GitHub through the REST API.
 * Used when git-over-443 is unreachable but api.github.com works.
 *
 *   GH_TOKEN=... OWNER=... REPO=... node scripts/push-via-api.mjs
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const token = process.env.GH_TOKEN
const owner = process.env.OWNER
const repo = process.env.REPO
if (!token || !owner || !repo) {
  console.error('GH_TOKEN, OWNER and REPO are required')
  process.exit(2)
}

const MESSAGE = process.env.COMMIT_MESSAGE ?? 'feat: per-model session-id headers for Claude Code / OpenCode Go'

async function api(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-model-session-headers',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`)
  return text === '' ? undefined : JSON.parse(text)
}

// `.github/workflows/*` needs the `workflow` token scope; skip it when absent.
const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((path) => !path.startsWith('.github/workflows/'))

const existing = await api(`/repos/${owner}/${repo}/git/ref/heads/main`).catch(() => undefined)
const parent = existing?.object?.sha
console.log(`files: ${files.length}, parent: ${parent ?? '(empty repo)'}`)

const tree = []
for (const path of files) {
  const blob = await api(`/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: readFileSync(path).toString('base64'), encoding: 'base64' }),
  })
  tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
  console.log(`  blob ${path}`)
}

const createdTree = await api(`/repos/${owner}/${repo}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ tree }),
})

const commit = await api(`/repos/${owner}/${repo}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message: MESSAGE, tree: createdTree.sha, parents: parent ? [parent] : [] }),
})

if (parent) {
  await api(`/repos/${owner}/${repo}/git/refs/heads/main`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: true }),
  })
} else {
  await api(`/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.sha }),
  })
}

console.log(`pushed ${commit.sha}`)

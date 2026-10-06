#!/usr/bin/env node
// One-time setup for dsh-gh-pages-artifacts, run by a person (not by the agent).
// It uses your own GitHub CLI login to create the artifacts repository, the Pages branch,
// and the GitHub Pages site, then prints the plugin configuration and token instructions.
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout, argv, env, exit } from 'node:process'

const USAGE = `Usage: node bin/setup.mjs setup [options]   (or: npx dsh-gh-pages-artifacts setup)

Creates (when missing) a public GitHub repository for artifacts, a Pages branch, and
the GitHub Pages site, using your GitHub CLI ("gh") login. Nothing is changed without
confirmation unless --yes is given.

Options:
  --owner <login>    User or organization that owns the repository (default: your gh user)
  --repo <name>      Repository name (default: dsh-artifacts)
  --branch <name>    Pages branch (default: gh-pages)
  --docs             Publish from the /docs folder instead of the branch root
  --private          Create a private repository (GitHub Pro/Team/Enterprise only;
                     the published pages are still public). Implies --docs, so the
                     artifact index at the branch root is not served
  --author "Name <email>"
                     Author and committer of the commits setup creates
                     (default: GitHub's identity for your account)
  --yes              Do not ask for confirmation
  -h, --help         Show this help`

function parseArgs(args) {
  const options = { owner: undefined, repo: 'dsh-artifacts', branch: 'gh-pages', docs: false, private: false, yes: false, author: undefined }
  const rest = [...args]
  if (rest[0] === 'setup') rest.shift()
  while (rest.length > 0) {
    const arg = rest.shift()
    const value = () => {
      const next = rest.shift()
      if (next === undefined || next.startsWith('--')) fail(`${arg} needs a value`)
      return next
    }
    switch (arg) {
      case '--owner': options.owner = value(); break
      case '--repo': options.repo = value(); break
      case '--branch': options.branch = value(); break
      case '--docs': options.docs = true; break
      case '--private': options.private = true; break
      case '--author': {
        const match = /^\s*([^<>]*?)\s*<([^\s<>@]+@[^\s<>@]+)>\s*$/.exec(value())
        if (match === null || match[1] === '') fail('--author must look like "Name <email@example.com>"')
        options.author = { name: match[1], email: match[2] }
        break
      }
      case '--yes': case '-y': options.yes = true; break
      case '-h': case '--help': console.log(USAGE); exit(0); break
      default: fail(`unknown option ${arg}\n\n${USAGE}`)
    }
  }
  if (options.private) options.docs = true
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(options.repo)) fail(`invalid repository name ${options.repo}`)
  if (options.owner !== undefined && !/^[A-Za-z0-9-]{1,39}$/.test(options.owner)) fail(`invalid owner ${options.owner}`)
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(options.branch) || options.branch.includes('..')) fail(`invalid branch ${options.branch}`)
  return options
}

function fail(message) {
  console.error(`error: ${message}`)
  exit(1)
}

/** Environment for gh: plain, uncoloured, unpaged output whatever the user's shell forces. */
const GH_ENV = (() => {
  const clean = { ...env, CLICOLOR_FORCE: '0', NO_COLOR: '1', GH_PAGER: 'cat', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' }
  delete clean.GH_FORCE_TTY
  return clean
})()

/** Run `gh api`; returns { ok, status, data }. Never prints the token. */
function ghApi(method, path, body) {
  const args = ['api', '-X', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', '-i', path]
  if (body !== undefined) args.push('--input', '-')
  let output
  try {
    output = execFileSync('gh', args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: GH_ENV })
  } catch (error) {
    if (error.code === 'ENOENT') fail('the GitHub CLI (gh) is not installed; get it from https://cli.github.com and run "gh auth login"')
    output = `${error.stdout ?? ''}`
    if (output === '') fail(`gh api ${method} ${path} failed: ${(error.stderr ?? error.message).trim()}`)
  }
  const split = output.search(/\r?\n\r?\n/)
  const head = split < 0 ? output : output.slice(0, split)
  const text = split < 0 ? '' : output.slice(split).trim()
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/m.exec(head)?.[1] ?? 0)
  let data
  try { data = text === '' ? undefined : JSON.parse(text) } catch { data = text }
  return { ok: status >= 200 && status < 300, status, data }
}

/** Give a repository its first commit with a known author (auto_init would use the account's email). */
async function initializeRepository(owner, repo, options) {
  const readme = '# Artifacts\n\nPages published by DeepSeek Harness agents with dsh-gh-pages-artifacts. They are served from the `' + options.branch + '` branch.\n'
  let initialized
  for (let attempt = 0; attempt < 5; attempt++) {
    initialized = ghApi('PUT', `/repos/${owner}/${repo}/contents/README.md`, {
      message: 'Initialize artifacts repository',
      content: Buffer.from(readme).toString('base64'),
      ...authorFields(options.author),
    })
    if (initialized.ok || initialized.status !== 404 && initialized.status !== 409) break
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  if (!initialized.ok) fail(`could not initialize ${owner}/${repo} (HTTP ${initialized.status}): ${initialized.data?.message ?? ''}`)
}

function authorFields(author) {
  return author === undefined ? {} : { author: { ...author }, committer: { ...author } }
}

async function confirm(question, yes) {
  if (yes) return true
  if (!stdin.isTTY) fail('this command changes your GitHub account and must be run by a person in an interactive terminal')
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

async function main() {
  const options = parseArgs(argv.slice(2))
  const me = ghApi('GET', '/user')
  if (!me.ok || typeof me.data?.login !== 'string') {
    fail(`could not read your GitHub user (HTTP ${me.status}); run "gh auth login" for github.com and try again`)
  }
  const login = me.data.login
  const owner = options.owner ?? login
  const ownsRepo = owner.toLowerCase() === login.toLowerCase()
  const repo = options.repo
  const full = `${owner}/${repo}`
  const sitePath = options.docs ? '/docs' : '/'
  const nojekyll = options.docs ? 'docs/.nojekyll' : '.nojekyll'
  if (repo.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
    fail(`use a dedicated repository, not your ${repo} site: artifacts would share its root and its service-worker scope`)
  }

  // 1. Repository.
  let repository = ghApi('GET', `/repos/${owner}/${repo}`)
  if (repository.status === 404) {
    const visibility = options.private ? 'PRIVATE' : 'PUBLIC'
    if (!await confirm(`Create the ${visibility} repository ${full}?`, options.yes)) fail('cancelled')
    const body = {
      name: repo,
      description: 'Artifacts published by DeepSeek Harness agents (dsh-gh-pages-artifacts)',
      private: options.private,
      auto_init: false,
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    }
    if (!ownsRepo) {
      const account = ghApi('GET', `/users/${owner}`)
      if (account.data?.type !== 'Organization') fail(`you can only create repositories under your own account (${login}) or an organization you belong to`)
    }
    const created = ownsRepo ? ghApi('POST', '/user/repos', body) : ghApi('POST', `/orgs/${owner}/repos`, body)
    if (!created.ok) fail(`could not create ${full} (HTTP ${created.status}): ${created.data?.message ?? ''}`)
    console.log(`created ${created.data.html_url}`)
    repository = created
    await initializeRepository(owner, repo, options)
  } else if (!repository.ok) {
    fail(`could not read ${full} (HTTP ${repository.status}): ${repository.data?.message ?? ''}`)
  } else {
    console.log(`repository ${full} exists`)
  }

  // 2. Pages branch, created as an orphan holding only .nojekyll.
  let ref = ghApi('GET', `/repos/${owner}/${repo}/git/ref/heads/${options.branch}`)
  if (ref.status === 409 && /empty/i.test(ref.data?.message ?? '')) {
    // An existing repository without commits: the Git Data API needs a first commit.
    if (!await confirm(`${full} is empty. Add a README commit so branches can be created?`, options.yes)) fail('cancelled')
    await initializeRepository(owner, repo, options)
    ref = ghApi('GET', `/repos/${owner}/${repo}/git/ref/heads/${options.branch}`)
  }
  for (let attempt = 0; ref.status === 409 && attempt < 5; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    ref = ghApi('GET', `/repos/${owner}/${repo}/git/ref/heads/${options.branch}`)
  }
  if (ref.status === 404) {
    if (!await confirm(`Create the branch ${options.branch} in ${full}?`, options.yes)) fail('cancelled')
    const tree = ghApi('POST', `/repos/${owner}/${repo}/git/trees`, {
      tree: [{ path: nojekyll, mode: '100644', type: 'blob', content: '# Disables Jekyll so GitHub Pages serves files exactly as committed.\n' }],
    })
    if (!tree.ok) fail(`could not create the branch tree (HTTP ${tree.status}): ${tree.data?.message ?? ''}`)
    const commit = ghApi('POST', `/repos/${owner}/${repo}/git/commits`, { message: 'Initialize GitHub Pages branch for dsh artifacts', tree: tree.data.sha, parents: [], ...authorFields(options.author) })
    if (!commit.ok) fail(`could not create the branch commit (HTTP ${commit.status}): ${commit.data?.message ?? ''}`)
    const created = ghApi('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${options.branch}`, sha: commit.data.sha })
    if (!created.ok) fail(`could not create branch ${options.branch} (HTTP ${created.status}): ${created.data?.message ?? ''}`)
    console.log(`created branch ${options.branch}`)
  } else if (!ref.ok) {
    fail(`could not read branch ${options.branch} (HTTP ${ref.status}): ${ref.data?.message ?? ''}`)
  } else {
    console.log(`branch ${options.branch} exists`)
  }

  // 3. GitHub Pages site, deployed from the branch.
  let pages = ghApi('GET', `/repos/${owner}/${repo}/pages`)
  if (pages.status === 404) {
    if (!await confirm(`Enable GitHub Pages for ${full} from ${options.branch} ${sitePath}?`, options.yes)) fail('cancelled')
    const created = ghApi('POST', `/repos/${owner}/${repo}/pages`, { build_type: 'legacy', source: { branch: options.branch, path: sitePath } })
    // Pushing a gh-pages branch can enable Pages on its own, so "already enabled" (409) is fine.
    if (!created.ok && created.status !== 409) fail(`could not enable GitHub Pages (HTTP ${created.status}): ${created.data?.message ?? ''}`)
    pages = ghApi('GET', `/repos/${owner}/${repo}/pages`)
    if (!pages.ok) fail(`could not read the GitHub Pages settings (HTTP ${pages.status}): ${pages.data?.message ?? ''}`)
    console.log(created.ok ? 'enabled GitHub Pages' : 'GitHub Pages was enabled automatically')
  }
  if (pages.ok) {
    const source = pages.data.source ?? {}
    if (pages.data.build_type === 'workflow' || source.branch !== options.branch || (source.path ?? '/') !== sitePath) {
      const current = pages.data.build_type === 'workflow' ? 'a GitHub Actions workflow' : `${source.branch} ${source.path}`
      if (await confirm(`GitHub Pages currently publishes from ${current}. Switch it to ${options.branch} ${sitePath}?`, options.yes)) {
        const updated = ghApi('PUT', `/repos/${owner}/${repo}/pages`, { build_type: 'legacy', source: { branch: options.branch, path: sitePath } })
        if (!updated.ok) fail(`could not update GitHub Pages (HTTP ${updated.status}): ${updated.data?.message ?? ''}`)
        pages = ghApi('GET', `/repos/${owner}/${repo}/pages`)
        console.log('updated the GitHub Pages source')
      } else {
        console.log('left the GitHub Pages source unchanged; artifacts will not be served until it matches')
      }
    } else {
      console.log('GitHub Pages is enabled')
    }
  } else {
    fail(`could not read the GitHub Pages settings (HTTP ${pages.status}): ${pages.data?.message ?? ''}`)
  }

  const siteUrl = String(pages.data?.html_url ?? `https://${owner.toLowerCase()}.github.io/${repo}/`).replace(/^http:\/\/([^/]+\.github\.io)/, 'https://$1')
  const configLines = [
    '- id: gh-pages-artifacts',
    '  config:',
    `    owner: ${owner}`,
    `    repo: ${repo}`,
    ...options.branch === 'gh-pages' ? [] : [`    branch: ${options.branch}`],
    ...options.docs ? ['    siteDir: docs'] : [],
    ...options.author === undefined ? [] : ['    commitAuthor:', `      name: ${JSON.stringify(options.author.name)}`, `      email: ${options.author.email}`],
  ]
  console.log(`
Done. Artifacts will be served under ${siteUrl}

Next steps
1. Create a fine-grained personal access token:
     https://github.com/settings/personal-access-tokens/new
   Resource owner: ${owner}
   Repository access: Only select repositories -> ${full}
   Repository permissions: Contents: Read and write; Pages: Read-only (recommended, for status checks)

2. Give it to DeepSeek Harness as the GH_PAGES_TOKEN credential, for example in
   $DSH_HOME/.credentials.yaml (default ~/.dsh/.credentials.yaml, chmod 600):

     version: 1
     refs:
       GH_PAGES_TOKEN: <paste the token here, never in a chat>

   or export GH_PAGES_TOKEN in the environment that launches dsh.

3. Add this row to your profile's cordis.patch.yml
   (~/.dsh/profiles/<profile>/cordis.patch.yml; Desktop: Settings -> Open configuration file):

${configLines.map(line => `     ${line}`).join('\n')}
`)
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)))

/** Read publish sources from the Session workspace and screen text before it goes public. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/**
 * Read one regular file that lies inside the Session working directory. Publishing makes data
 * public, so this is stricter than the built-in read tool: symlinks, directories, and paths that
 * resolve outside the workspace are refused.
 * @param ctx - plugin context providing `fs`.
 * @param exec - tool execution (Session working directory, cancellation).
 * @param path - workspace-relative or absolute path.
 * @param maxBytes - size ceiling.
 * @returns the file bytes.
 */
export async function readWorkspaceFile(ctx: Context, exec: ToolRunContext, path: string, maxBytes: number): Promise<Uint8Array> {
  if (path.trim() === '') throw new Error('path must not be empty')
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('Publishing from a path needs the filesystem service, which this harness does not provide; pass the content inline instead')
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) throw new Error('Publishing from a path needs a Session workspace; pass the content inline instead')
  const signal = exec.signal
  const entry = await fs.lstat(path, { cwd }, signal)
  if (entry === undefined) throw new Error(`${path} does not exist; write the file first or check the path`)
  if (entry.type !== 'file') throw new Error(`${path} is not a regular file (symlinks and directories are not published)`)
  const root = await fs.resolve(cwd, { signal })
  const target = await fs.resolve(path, { cwd, signal })
  if (!fs.contains(root, target)) throw new Error(`${path} is outside the Session workspace; only files inside the workspace can be published`)
  const info = await fs.stat(target, signal)
  if (info === undefined || info.type !== 'file') throw new Error(`${path} is not a regular file`)
  if (info.size !== undefined && info.size > maxBytes) {
    throw new Error(`${path} is ${formatBytes(info.size)}, above the ${formatBytes(maxBytes)} publish limit`)
  }
  return await fs.readBytes(target, signal, maxBytes)
}

/**
 * The last path segment, used as the default asset name.
 * @param path - workspace path.
 */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(part => part !== '')
  return parts.at(-1) ?? path
}

/** Extensions published as text and therefore screened for secrets. */
const TEXT_EXTENSIONS = new Set([
  'html', 'htm', 'md', 'markdown', 'txt', 'css', 'js', 'mjs', 'json', 'svg', 'xml', 'csv', 'tsv', 'yaml', 'yml', 'map',
])

/**
 * @param name - file name.
 * @returns whether the name has a text extension.
 */
export function isTextName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { label: 'private key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { label: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'AWS secret access key', pattern: /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}\b/i },
  { label: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'API secret key (sk-...)', pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/ },
  { label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'Google OAuth token', pattern: /\b(?:ya29\.[0-9A-Za-z_-]{20,}|1\/\/0[0-9A-Za-z_-]{30,})/ },
  { label: 'Stripe secret key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { label: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { label: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'Hugging Face token', pattern: /\bhf_[A-Za-z0-9]{30,}\b/ },
  { label: 'PyPI token', pattern: /\bpypi-[A-Za-z0-9_-]{50,}\b/ },
  { label: 'JSON Web Token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { label: 'password in a URL', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@'"<>]+:[^\s/?#@'"<>]{3,}@[^\s/?#'"<>]+/i },
  {
    label: 'password or secret assignment',
    pattern: /\b(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']?(?=[^\s"'<>{}$]*\d)(?=[^\s"'<>{}$]*[A-Za-z])[^\s"'<>{}$]{12,}/i,
  },
]

/**
 * Find credential-like strings in text that is about to be published.
 * @param text - content to screen.
 * @param knownSecrets - exact secret values that must never appear (for example the token in use);
 *   their base64, hex, and URL-encoded forms are checked too.
 * @returns labels of the kinds found; empty when clean.
 */
export function findSecrets(text: string, knownSecrets: readonly string[] = []): string[] {
  const found = new Set<string>()
  for (const secret of knownSecrets) {
    if (secret.length < 8) continue
    const forms = [
      secret,
      Buffer.from(secret).toString('base64').replace(/=+$/, ''),
      Buffer.from(secret).toString('base64url'),
      Buffer.from(secret).toString('hex'),
      encodeURIComponent(secret),
    ]
    if (forms.some(form => text.includes(form))) found.add('the GitHub token this plugin uses')
  }
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) found.add(label)
  }
  return [...found]
}

const CREDENTIAL_NAMES = [
  /^\.env(?:\..*)?$/i, /^\.envrc$/i, /^\.netrc$/i, /^_netrc$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.git-credentials$/i,
  /^\.pgpass$/i, /^\.htpasswd$/i, /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i, /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|ovpn)$/i,
  /^credentials(?:\.(?:json|ya?ml|toml|ini|env|csv))?$/i, /^secrets?\.(?:json|ya?ml|toml|ini|env)$/i, /^\.credentials\.ya?ml$/i, /^service[-_]?account.*\.json$/i,
  /^application_default_credentials\.json$/i, /^kubeconfig$/i,
]
const CREDENTIAL_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.dsh', '.git', '.kube', '.docker', '.config', '.azure', '.gcloud'])

/**
 * Check whether a workspace path looks like a credential file or a hidden file.
 * @param path - workspace path as given.
 * @returns a reason to refuse, or undefined when it looks like ordinary content.
 */
export function credentialPathProblem(path: string): string | undefined {
  const segments = path.split(/[\\/]/).filter(segment => segment !== '' && segment !== '.')
  for (const segment of segments.slice(0, -1)) {
    if (CREDENTIAL_DIRS.has(segment.toLowerCase())) return `${path} is inside ${segment}/, which holds credentials or configuration`
  }
  const name = segments.at(-1) ?? path
  if (CREDENTIAL_NAMES.some(pattern => pattern.test(name))) return `${path} looks like a credential or key file`
  if (name.startsWith('.')) return `${path} is a hidden file`
  return undefined
}

/**
 * @param bytes - byte count.
 * @returns a short human size.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

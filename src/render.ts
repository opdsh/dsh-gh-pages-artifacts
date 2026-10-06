/** Turn artifact sources into the HTML that GitHub Pages serves. */
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'

/** Page decorations controlled by configuration. */
export interface PageOptions {
  /** Add a robots noindex meta tag. */
  readonly noindex: boolean
  /** Content-Security-Policy for a meta tag; '' for none. */
  readonly csp: string
}

const GENERATOR = 'dsh-gh-pages-artifacts'

/**
 * Render a Markdown document into a complete, styled HTML page. Raw HTML in the Markdown is
 * escaped and unsafe link protocols are dropped (micromark defaults).
 * @param input - title, optional description, Markdown source.
 * @param options - page decorations.
 * @returns the HTML document.
 */
export function renderMarkdownPage(input: { title: string; description?: string | undefined; markdown: string }, options: PageOptions): string {
  const body = micromark(input.markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()] })
  const head = [
    '<meta charset="utf-8">',
    ...securityMeta(options),
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="${GENERATOR}">`,
    ...input.description === undefined ? [] : [`<meta name="description" content="${escapeAttribute(input.description)}">`],
    `<title>${escapeText(input.title)}</title>`,
    `<style>${DOCUMENT_CSS}</style>`,
  ]
  return `<!doctype html>\n<html lang="en">\n<head>\n${head.join('\n')}\n</head>\n<body>\n<main class="doc">\n${body}</main>\n</body>\n</html>\n`
}

/** Attribute that marks the tags this plugin injects, so they can be removed again. */
export const INJECTED_ATTRIBUTE = 'data-dsh-artifacts'
const INJECTED_TAG = new RegExp(`\\r?\\n?[ \\t]*<meta\\b[^>]*\\b${INJECTED_ATTRIBUTE}\\b[^>]*>`, 'gi')

/**
 * Remove tags a previous publish injected, giving back the page as its author wrote it.
 * @param html - served page.
 * @returns the page without plugin-injected meta tags.
 */
export function stripInjected(html: string): string {
  return html.replace(INJECTED_TAG, '')
}

/**
 * Prepare an HTML page for publishing: complete a fragment into a document and add the
 * configured meta tags right after `<head>` so they apply before any other content. Tags from
 * earlier publishes are removed first, so read-modify-publish cycles do not pile them up.
 * @param input - title used when the source is a fragment, and the HTML source.
 * @param options - page decorations.
 * @returns the HTML document.
 */
export function prepareHtmlPage(input: { title: string; html: string }, options: PageOptions): string {
  const html = stripInjected(input.html.replace(/^\uFEFF/, ''))
  const additions = securityMeta(options)
  const headOpen = firstTagOutsideComments(html, /<head(?:\s[^>]*)?>/gi)
  if (headOpen !== undefined) {
    const at = headOpen.index + headOpen.length
    return additions.length === 0 ? html : `${html.slice(0, at)}\n${additions.join('\n')}${html.slice(at)}`
  }
  const htmlOpen = firstTagOutsideComments(html, /<html(?:\s[^>]*)?>/gi)
  if (htmlOpen !== undefined) {
    const at = htmlOpen.index + htmlOpen.length
    const head = ['<meta charset="utf-8">', ...additions]
    if (!/<title[\s>]/i.test(html)) head.push(`<title>${escapeText(input.title)}</title>`)
    return `${html.slice(0, at)}\n<head>\n${head.join('\n')}\n</head>${html.slice(at)}`
  }
  const head = [
    '<meta charset="utf-8">',
    ...additions,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="${GENERATOR}">`,
    `<title>${escapeText(input.title)}</title>`,
  ]
  const doctype = /^\s*<!doctype html[^>]*>/i.exec(html)
  const content = doctype === null ? html : html.slice(doctype[0].length)
  return `<!doctype html>\n<html lang="en">\n<head>\n${head.join('\n')}\n</head>\n<body>\n${content.trim()}\n</body>\n</html>\n`
}

/** Find the first match of a tag pattern that is not inside an HTML comment. */
function firstTagOutsideComments(html: string, pattern: RegExp): { index: number; length: number } | undefined {
  const comments: Array<[number, number]> = []
  for (const match of html.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) comments.push([match.index, match.index + match[0].length])
  for (const match of html.matchAll(pattern)) {
    if (!comments.some(([start, end]) => match.index >= start && match.index < end)) return { index: match.index, length: match[0].length }
  }
  return undefined
}

function securityMeta(options: PageOptions): string[] {
  const tags: string[] = []
  if (options.csp !== '') tags.push(`<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(options.csp)}" ${INJECTED_ATTRIBUTE}>`)
  // Crawlers apply the most restrictive robots directive, so this wins over any the page sets.
  if (options.noindex) tags.push(`<meta name="robots" content="noindex, nofollow" ${INJECTED_ATTRIBUTE}>`)
  return tags
}

/** @param text - text for an HTML text node. */
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** @param text - text for a double-quoted HTML attribute. */
export function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;')
}

const DOCUMENT_CSS = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--code-bg:#f6f8fa;--link:#0969da;--accent-bg:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#3d444d;--code-bg:#151b23;--link:#4493f8;--accent-bg:#151b23}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji";overflow-wrap:break-word}
.doc{max-width:46rem;margin:0 auto;padding:3rem 1rem 4rem}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:2rem 0 1rem;font-weight:600}
h1{font-size:2rem;margin-top:0;padding-bottom:.3em;border-bottom:1px solid var(--border)}
h2{font-size:1.5rem;padding-bottom:.3em;border-bottom:1px solid var(--border)}
h3{font-size:1.25rem}
p,ul,ol,dl,table,pre,blockquote{margin:0 0 1rem}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
img,video{max-width:100%;height:auto}
hr{border:0;border-top:1px solid var(--border);margin:2rem 0}
blockquote{padding:0 1em;color:var(--muted);border-left:.25em solid var(--border)}
code,pre{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:.875em}
code{padding:.2em .4em;background:var(--code-bg);border-radius:6px}
pre{padding:1rem;overflow:auto;background:var(--code-bg);border-radius:6px;line-height:1.45}
pre code{padding:0;background:transparent;font-size:inherit}
table{display:block;width:max-content;max-width:100%;overflow:auto;border-collapse:collapse}
th,td{padding:.4rem .8rem;border:1px solid var(--border)}
th{font-weight:600;background:var(--accent-bg)}
li+li{margin-top:.25em}
ul.contains-task-list{list-style:none;padding-left:1.2em}
input[type=checkbox]{margin:0 .4em 0 -1.2em;vertical-align:middle}
.footnotes{font-size:.875rem;color:var(--muted)}
@media print{body{background:#fff;color:#000}.doc{padding:0}}
`.trim()

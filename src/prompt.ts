/** Short, static system-prompt guidance, shown only to Agents that can see the publish tool. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { PUBLISH_TOOL } from './names.js'

/** Order between first-party tool guidance (up to 3100) and the tools SDK (5000). */
export const PROMPT_ORDER = 3250

/**
 * Guidance text. Static per configuration so the provider prefix cache stays warm.
 * @param withSkill - whether the bundled artifact-pages skill is registered.
 */
export function promptText(withSkill: boolean): string {
  return [
    '# Shareable artifacts',
    'You can publish web pages and documents as shareable links on GitHub Pages with artifact_publish, and manage them with artifact_list, artifact_read, artifact_delete, artifact_status, and artifact_repository.',
    '- Use them when the user wants something they can open in a browser or share: a report, dashboard, visualization, demo, or long document.',
    '- Published artifacts are public. Never publish secrets, credentials, or private data unless the user explicitly asks to share them.',
    '- Write the page to a workspace file first and pass path. Update an existing artifact by passing its id, so the link stays the same.',
    ...withSkill ? ['- For design and structure guidance, load the artifact-pages skill before writing the page.'] : [],
    '- After publishing, give the user the link as Markdown, e.g. [Title](url). When asked what was published, use artifact_list and show the links.',
    '- When the user wants to choose where artifacts go (one new repository per artifact, or a repository they name), use artifact_repository.',
  ].join('\n')
}

/**
 * Register the guidance section.
 * @param ctx - context exposing `systemPrompt` and `tools`.
 * @param withSkill - whether to point at the bundled skill.
 */
export function registerPrompt(ctx: Context, withSkill: boolean): void {
  const text = promptText(withSkill)
  ctx.systemPrompt.section({
    name: 'gh-pages-artifacts',
    order: PROMPT_ORDER,
    interpolate: false,
    text: ({ scope }) => ctx.tools.get(PUBLISH_TOOL, scope) === undefined ? '' : text,
  })
}

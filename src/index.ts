/**
 * DeepSeek Harness plugin that lets agents publish HTML pages and Markdown documents as
 * shareable artifacts on GitHub Pages.
 * @module dsh-gh-pages-artifacts
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import { Config, normalizeConfig } from './config.js'
import { registerPrompt } from './prompt.js'
import { ArtifactsRuntime } from './service.js'
import { registerSkill } from './skill.js'
import { ALL_TOOLS, createTools, MUTATING_TOOLS } from './tools.js'
import { installVisibility } from './visibility.js'
import { installWebRoutes } from './web-routes.js'

export { Config }
export type { ApprovalMode, RepoStrategy, SubagentAccess, Settings } from './config.js'
export { ArtifactsRuntime, VERSION } from './service.js'
export type { RuntimeHooks } from './service.js'
export { ALL_TOOLS, MUTATING_TOOLS, PUBLISH_TOOL, LIST_TOOL, READ_TOOL, DELETE_TOOL, STATUS_TOOL, REPOSITORY_TOOL } from './tools.js'

/** Loader identity. */
export const name = 'gh-pages-artifacts'

/** Required services; the skill registry, system prompt, credentials, and approval are optional. */
export const inject = ['tools']

/**
 * Register the artifact tools, their visibility rules, prompt guidance, and the bundled skill.
 * @param ctx - host plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Validate once up front; volatile options (edited on the settings page) are re-read per operation.
  const settings = normalizeConfig(config)
  // The entry id names this row's settings namespace, which artifact_repository writes to.
  const entryId = (ctx.fiber as { entry?: { options?: { id?: unknown } } }).entry?.options?.id
  const runtime = new ArtifactsRuntime(ctx, () => normalizeConfig(config), {}, typeof entryId === 'string' ? entryId : undefined)
  for (const tool of createTools(runtime)) ctx.tools.register(tool)
  // The sidebar's Artifacts panel reads the list through these routes (web and desktop only).
  installWebRoutes(ctx, runtime)
  installVisibility(ctx, {
    allTools: ALL_TOOLS,
    mutatingTools: MUTATING_TOOLS,
    hideFromPresets: settings.hideFromPresets,
    subagentAccess: settings.subagentAccess,
  })
  if (settings.promptGuidance) ctx.inject(['systemPrompt'], promptCtx => registerPrompt(promptCtx, settings.bundledSkill))
  if (settings.bundledSkill) {
    ctx.inject(['skills'], async (skillsCtx) => {
      try {
        await registerSkill(skillsCtx)
      } catch (error) {
        skillsCtx.logger.warn(`gh-pages-artifacts: bundled skill unavailable: ${String(error)}`)
      }
    })
  }
}

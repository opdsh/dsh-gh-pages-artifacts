/**
 * Hide artifact tools from configured presets and from delegated subagents. The tools register
 * globally, so every Agent sees them unless its own scope restricts them. The restriction is
 * reconciled for Agents that exist at load time, when an Agent is created, and when a preset is
 * selected, because the Web UI picks the mode after the Session's Agent already exists. The tools
 * also check the same policy when they run, so a missed restriction cannot open them.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SubagentAccess } from './config.js'

/** Inputs for {@link installVisibility}. */
export interface VisibilityOptions {
  /** Every tool this plugin registers. */
  readonly allTools: readonly string[]
  /** Tools that change published content. */
  readonly mutatingTools: readonly string[]
  /** Presets that see no artifact tools. */
  readonly hideFromPresets: readonly string[]
  /** Subagent policy. */
  readonly subagentAccess: SubagentAccess
}

/**
 * Compute which tools one Agent must not see.
 * @param options - visibility settings.
 * @param preset - the Agent's preset id, when known.
 * @param delegated - whether the Agent is a delegated subagent.
 * @returns tool names to deny, sorted.
 */
export function hiddenTools(options: VisibilityOptions, preset: string | undefined, delegated: boolean): string[] {
  if (preset !== undefined && options.hideFromPresets.includes(preset)) return [...options.allTools].sort()
  if (delegated) {
    if (options.subagentAccess === 'none') return [...options.allTools].sort()
    if (options.subagentAccess === 'read-only') return [...options.mutatingTools].sort()
  }
  return []
}

/**
 * Keep per-Agent tool restrictions in sync with presets and delegation.
 * @param ctx - plugin context (host root).
 * @param options - visibility settings.
 */
export function installVisibility(ctx: Context, options: VisibilityOptions): void {
  if (options.hideFromPresets.length === 0 && options.subagentAccess === 'full') return
  const applied = new Map<Agent, { key: string; dispose: () => void }>()
  ctx.effect(() => () => {
    for (const entry of applied.values()) safeDispose(entry.dispose)
    applied.clear()
  }, 'gh-pages-artifacts.visibility')

  const reconcile = (agent: Agent, selectedPreset?: string): void => {
    try {
      const preset = selectedPreset ?? ctx.get('agentPresets')?.composedPreset(agent.ctx)
      const delegated = (agent.session.header.delegationDepth ?? 0) > 0 || agent.session.header.origin === 'subagent'
      const deny = hiddenTools(options, preset, delegated)
      const key = deny.join(',')
      const current = applied.get(agent)
      if (current?.key === key) return
      if (current !== undefined) {
        safeDispose(current.dispose)
        applied.delete(agent)
      }
      if (deny.length === 0) return
      const dispose = agent.ctx.effect(() => agent.ctx.tools.restrict({ deny }), 'gh-pages-artifacts.restrict')
      applied.set(agent, { key, dispose })
    } catch (error) {
      ctx.logger.warn(`gh-pages-artifacts: could not update artifact tool visibility: ${String(error)}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    reconcile(agent)
    return undefined
  })
  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    const agent = ctx.get('agents')?.get(sessionId)
    if (agent !== undefined) reconcile(agent, agentPreset)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const entry = applied.get(agent)
    applied.delete(agent)
    if (entry !== undefined) safeDispose(entry.dispose)
  })
  // Agents that already run when the plugin loads or reloads (for example after a config edit).
  for (const agent of ctx.get('agents')?.list() ?? []) reconcile(agent)
}

function safeDispose(dispose: () => void): void {
  try {
    dispose()
  } catch {
    // The Agent scope may already be gone; its restrictions went with it.
  }
}

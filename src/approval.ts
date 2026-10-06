/** Approval gate for outward-facing artifact changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalMode } from './config.js'

/** What the user is asked to approve. */
export interface ApprovalAsk {
  /** Tool name shown with the request. */
  readonly toolName: string
  /** Audit text persisted with the request. */
  readonly reason: string
  /** Text shown in the approval panel. */
  readonly display: string
}

/**
 * Ask the user before a publish, update, or delete, following the configured mode. With
 * 'unless-full-access' the prompt is skipped only in sessions that run with the danger-full-access
 * sandbox and never prompt for approval (the "Full access" preset). The gate runs
 * inside the tool body, after arguments and the target URL are known, so the prompt names the
 * exact URL. Only an explicit 'allowed-once' lets the change through.
 * @param ctx - plugin context.
 * @param mode - configured approval mode.
 * @param exec - tool execution.
 * @param ask - request text.
 * @throws Error with a model-facing explanation when approval is not granted.
 */
export async function requireApproval(ctx: Context, mode: ApprovalMode, exec: ToolRunContext, ask: ApprovalAsk): Promise<void> {
  if (mode === 'off') return
  const agent = exec.agent
  const approval = ctx.get('approval')
  const policy = approval === undefined || agent === undefined
    ? undefined
    : approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask'
  if (mode === 'unless-full-access') {
    // Full access means the danger-full-access sandbox *and* no approval prompts, the way the
    // shipped "Full access" preset is defined. Auto mode keeps prompting, so it is asked here too.
    const sandbox = ctx.get('sandboxPolicy')?.resolve(agent === undefined ? {} : { session: agent.session })
    if (sandbox?.mode === 'danger-full-access' && (policy === undefined || policy === 'never')) return
  }
  if (approval === undefined || agent === undefined || policy === undefined) {
    throw new Error(`${ask.toolName} needs the user's approval, but this harness has no approval channel. `
      + 'Ask the user to publish from an interactive session, or to set the plugin option approval: off.')
  }
  if (policy === 'never') {
    const delegated = (agent.session.header.delegationDepth ?? 0) > 0
    throw new Error(delegated
      ? `${ask.toolName} needs the user's approval, which a delegated subagent cannot request. Return the content to the parent agent so it can publish.`
      : `${ask.toolName} needs the user's approval, but this session rejects approval requests automatically. Ask the user to change the permission mode, then retry.`)
  }
  const outcome = await approval.request({
    agent,
    toolName: ask.toolName,
    callId: exec.callId,
    reason: ask.reason,
    displayReason: { en: ask.display },
    signal: exec.signal,
  })
  switch (outcome) {
    case 'allowed-once':
      exec.signal.throwIfAborted()
      return
    case 'rejected':
      throw new Error(`The user declined: ${ask.reason}. Do not retry unless the user asks again.`)
    case 'cancelled':
      throw new Error(`The approval request was cancelled: ${ask.reason}`)
    case 'unavailable':
      throw new Error(`${ask.toolName} needs the user's approval, but no approval channel is available right now (for example a headless run).`)
    default:
      throw new Error(`${ask.toolName} was not approved`)
  }
}

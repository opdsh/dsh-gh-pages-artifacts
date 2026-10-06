/** Shared test harness: the real dsh tool, approval, fs, sandbox, and skill services plus the plugin, against an in-memory GitHub. */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import * as plugin from '../src/index.js'
import { FakeGitHub } from './fake-github.js'

export interface Harness {
  ctx: Context
  fake: FakeGitHub
  workspace: string
  agent: Agent
  asked: ApprovalRequest[]
  answer: { outcome: ApprovalOutcome }
  call(name: string, args: Record<string, unknown>, agent?: Agent): Promise<ToolExecutionResult>
}

let counter = 0

/** Reset call and session counters between tests. */
export function resetCounter(): void {
  counter = 0
}
export const TOKEN_ENV = 'GH_PAGES_TOKEN_TEST'

export function makeAgent(cwd: string, header: { delegationDepth?: number } = {}): Agent {
  const id = SessionId(`session-${++counter}`)
  const session = Session.create(id, undefined, { version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, ...header })
  session.append('turn/start', { turn: 1 })
  return { id, session } as unknown as Agent
}

export async function harness(options: {
  config?: Record<string, unknown>
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approval?: boolean
  approvalPolicy?: 'ask' | 'never'
  pages?: 'enabled' | 'disabled'
} = {}): Promise<Harness> {
  const fake = new FakeGitHub()
  fake.addRepo('dsh-artifacts', { branch: 'gh-pages', ...options.pages === 'disabled' ? { pages: null } : {} })
  vi.stubGlobal('fetch', fake.fetch)
  vi.stubEnv(TOKEN_ENV, fake.token)
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'artifacts-ws-')))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  await ctx.plugin(SandboxPolicyService, { mode: options.sandboxMode ?? 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(SkillRegistry)
  if (options.approval !== false) await ctx.plugin(ApprovalService, { policy: options.approvalPolicy ?? 'ask' })
  const asked: ApprovalRequest[] = []
  const answer = { outcome: 'allowed-once' as ApprovalOutcome }
  ctx.on('approval/request', (request) => {
    asked.push(request)
    return Promise.resolve(answer.outcome)
  })
  const registryDir = realpathSync(mkdtempSync(join(tmpdir(), 'artifacts-registry-')))
  await ctx.plugin(plugin, { tokenEnv: TOKEN_ENV, registryDir, ...options.config })
  await new Promise(resolve => setTimeout(resolve, 20))
  const agent = makeAgent(workspace)
  const call = async (name: string, args: Record<string, unknown>, who: Agent = agent) => await ctx.tools.execute({
    callId: ToolCallId(`call-${++counter}`), name, arguments: args, agent: who, signal: new AbortController().signal,
  })
  return { ctx, fake, workspace, agent, asked, answer, call }
}

export function text(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

export function value<T = Record<string, any>>(result: ToolExecutionResult): T {
  if (result.isError) throw new Error(`tool failed: ${text(result)}`)
  return result.value as T
}

export function pagesFiles(h: Harness): Map<string, string> {
  return h.fake.filesOf(h.fake.repos.get('octo/dsh-artifacts')!, 'gh-pages')
}

/** Bundled `artifact-pages` skill, registered at bundled precedence so user skills can override it. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillDefinition, type SkillProvider } from '@deepseek-ai/dsh-skill'

/** Skill name shown to the model and usable as `/artifact-pages`. */
export const SKILL_NAME = 'artifact-pages'

const PROVIDER_NAME = 'dsh-gh-pages-artifacts'
const SKILL_URL = new URL(`../assets/${SKILL_NAME}/SKILL.md`, import.meta.url)
const RESOURCE_BASE = { kind: 'directory', path: fileURLToPath(new URL(`../assets/${SKILL_NAME}/`, import.meta.url)) } as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u

/**
 * Split SKILL.md into its description and body.
 * @param text - file content.
 */
export function parseSkill(text: string): { description: string; body: string } {
  const match = FRONTMATTER.exec(text)
  if (match === null) throw new Error(`${SKILL_NAME}/SKILL.md has no frontmatter`)
  const line = /^description:\s*(.+)$/mu.exec(match[1] ?? '')
  const description = line?.[1]?.trim().replace(/^(['"])(.*)\1$/u, '$2') ?? ''
  if (description === '') throw new Error(`${SKILL_NAME}/SKILL.md has no description`)
  return { description, body: text.slice(match[0].length).trim() }
}

/**
 * Register the bundled skill provider.
 * @param ctx - context exposing `skills`.
 */
export async function registerSkill(ctx: Context): Promise<void> {
  const { description } = parseSkill(await readFile(SKILL_URL, 'utf8'))
  const candidate: SkillCandidate = {
    name: SKILL_NAME,
    description,
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: RESOURCE_BASE,
    rank: BUNDLED_SKILL_RANK,
    locator: SKILL_URL,
  }
  const provider: SkillProvider = {
    name: PROVIDER_NAME,
    list: () => Promise.resolve([candidate]),
    async get(): Promise<SkillDefinition> {
      const { body } = parseSkill(await readFile(SKILL_URL, 'utf8'))
      return {
        name: SKILL_NAME,
        description,
        invocation: INVOCATION,
        provider: PROVIDER_NAME,
        source: 'bundled',
        resourceBase: RESOURCE_BASE,
        content: body,
      }
    },
  }
  ctx.skills.registerProvider(() => provider)
}

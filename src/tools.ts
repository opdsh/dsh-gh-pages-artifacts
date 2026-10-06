/** Agent-facing tool definitions. */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { DELETE_TOOL, LIST_TOOL, PUBLISH_TOOL, READ_TOOL, REPOSITORY_TOOL, STATUS_TOOL } from './names.js'
import type { ArtifactsRuntime } from './service.js'

export { ALL_TOOLS, DELETE_TOOL, LIST_TOOL, MUTATING_TOOLS, PUBLISH_TOOL, READ_TOOL, REPOSITORY_TOOL, STATUS_TOOL } from './names.js'

const KIND = { type: 'string', enum: ['html', 'markdown'] } as const
const STRATEGY = { type: 'string', enum: ['shared', 'per-artifact'] } as const

/** Markdown link text with brackets removed so the link stays well formed. */
function linkText(text: string): string {
  return text.replace(/[[\]]/g, '')
}

/**
 * Build the artifact tools around one runtime.
 * @param runtime - shared operations.
 * @returns tool definitions ready for `ctx.tools.register`.
 */
export function createTools(runtime: ArtifactsRuntime): ToolDefinition[] {
  const publish = defineTool({
    name: PUBLISH_TOOL,
    description: 'Publish an HTML page or a Markdown document as a public artifact on GitHub Pages and get a shareable URL, '
      + 'or update an existing artifact in place (pass its id; the URL stays the same). '
      + 'Depending on the repository strategy (see artifact_repository), a new artifact goes into the shared repository or into a new repository of its own. '
      + 'Prefer writing the page to a workspace file first and passing path; use content only for short inline sources. '
      + 'HTML is served as-is (one self-contained file works best; extra files go in assets and are referenced by relative URLs). '
      + 'Markdown is rendered to a styled page. Anyone with the link can see the result and the repository may be public, '
      + 'so never publish secrets or private data the user did not ask to share. The user may be asked to approve. '
      + 'Changes go live in one to three minutes. Provide description first, then title, then the source.',
    parameters: {
      description: { type: 'string', required: true, description: 'One line saying what this artifact is, shown to the user and stored with it.' },
      title: { type: 'string', description: 'Page title. Required for a new artifact; on update it renames without changing the URL.' },
      id: { type: 'string', description: 'Id of an existing artifact to update in place. Omit to create a new artifact.' },
      path: { type: 'string', description: 'Workspace file to publish: .html/.htm for a page, .md/.markdown for a document. Relative paths use the Session working directory.' },
      kind: { ...KIND, description: 'html or markdown; inferred from the file extension or the content when omitted.' },
      slug: { type: 'string', description: 'URL id for a new artifact (lowercase letters, digits, hyphens). Default: derived from the title plus a random suffix.' },
      assets: {
        type: 'array',
        description: 'Extra workspace files (images, CSS, JS, data) published next to the page. On update, listed assets are added or replaced and the others are kept.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Workspace file to upload.' },
            name: { type: 'string', description: 'Published name relative to the page, e.g. img/chart.png. Defaults to the file name.' },
          },
        },
      },
      removeAssets: { type: 'array', items: { type: 'string' }, description: 'On update: asset names to delete.' },
      baseRev: { type: 'integer', description: 'On update: the rev you last saw. The update is refused if the artifact changed since.' },
      content: { type: 'string', description: 'Inline source when there is no workspace file: Markdown, or a whole HTML document starting with <!doctype html>. Prefer path for anything long.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          kind: { ...KIND, required: true },
          url: { type: 'string', required: true },
          repository: { type: 'string', required: true },
          newRepository: { type: 'boolean', required: true },
          rev: { type: 'integer', required: true },
          created: { type: 'boolean', required: true },
          commit: { type: 'string', required: true },
          files: { type: 'array', items: { type: 'string' }, required: true },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `${value.created ? 'Published' : `Updated (rev ${value.rev})`} "${value.title}" [id: ${value.id}]`,
          `URL: ${value.url}`,
          `Repository: ${value.repository}${value.newRepository ? ' (created for this artifact)' : ''}`,
          `Files: ${value.files.join(', ')}`,
          ...value.warnings.map(warning => `Warning: ${warning}`),
          'GitHub Pages usually serves the change within one to three minutes (browsers may cache the old version for up to 10 minutes).',
          `Give the user the link as Markdown: [${linkText(value.title)}](${value.url})`,
        ].join('\n'),
      }],
      presentationMeta: (_args, value) => ({ url: value.url, id: value.id, kind: value.kind, rev: value.rev, repository: value.repository }),
    },
    async execute(args, exec) {
      return await runtime.publish(args, exec)
    },
  })

  const list = defineTool({
    name: LIST_TOOL,
    description: 'List every artifact this plugin has published (newest first), across all repositories, with clickable links. '
      + 'Show them to the user as a Markdown list of links. The result also names a local index.html with the same links; '
      + 'pass it to the present tool when the user wants a page of all artifacts.',
    parameters: {
      query: { type: 'string', description: 'Only artifacts whose id, title, description, or repository contains this text.' },
      includeDeleted: { type: 'boolean', description: 'Also list deleted artifacts; default false.' },
      offset: { type: 'integer', description: 'Zero-based offset; default 0.' },
      limit: { type: 'integer', description: 'Page size from 1 to 200; default 50.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          artifacts: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                kind: { ...KIND, required: true },
                url: { type: 'string', required: true },
                repository: { type: 'string', required: true },
                rev: { type: 'integer', required: true },
                updatedAt: { type: 'string', required: true },
                status: { type: 'string', enum: ['published', 'deleted'], required: true },
                description: { type: 'string' },
              },
            },
          },
          indexFile: { type: 'string', required: true },
          notes: { type: 'array', items: { type: 'string' }, required: true },
          nextOffset: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.total === 0 ? 'No artifacts published yet.' : `${value.total} artifact${value.total === 1 ? '' : 's'}:`,
          ...value.artifacts.map(item => `- [${linkText(item.title)}](${item.url}) · id ${item.id} · ${item.kind} · rev ${item.rev} · ${item.repository} · updated ${item.updatedAt.slice(0, 16).replace('T', ' ')}`
            + (item.status === 'deleted' ? ' · deleted' : '') + (item.description === undefined ? '' : ` · ${item.description}`)),
          ...value.nextOffset === undefined ? [] : [`More: call again with offset ${value.nextOffset}.`],
          `Index page with all links: ${value.indexFile}`,
          ...value.notes.map(note => `Note: ${note}`),
        ].join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return await runtime.list(args, exec.signal)
    },
  })

  const read = defineTool({
    name: READ_TOOL,
    description: 'Read the source of a published artifact (the Markdown source of a document, or the HTML of a page), '
      + 'or another text file of it, in windows of up to 20000 characters. Use it before updating an artifact you did not just write.',
    parameters: {
      id: { type: 'string', required: true, description: 'Artifact id.' },
      file: { type: 'string', description: 'File to read, relative to the artifact; defaults to its source.' },
      offset: { type: 'integer', description: 'Zero-based character offset; default 0.' },
      limit: { type: 'integer', description: 'Characters to return, from 1 to 20000; default 8000.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          kind: { ...KIND, required: true },
          url: { type: 'string', required: true },
          repository: { type: 'string', required: true },
          rev: { type: 'integer', required: true },
          file: { type: 'string', required: true },
          files: { type: 'array', items: { type: 'string' }, required: true },
          totalChars: { type: 'integer', required: true },
          offset: { type: 'integer', required: true },
          content: { type: 'string', required: true },
          nextOffset: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `${value.title} [id: ${value.id}, ${value.kind}, rev ${value.rev}] ${value.url} (${value.repository})`,
          `File ${value.file}: characters ${value.offset}-${value.offset + value.content.length} of ${value.totalChars}. Files: ${value.files.join(', ')}`,
          ...value.nextOffset === undefined ? [] : [`More: call again with offset ${value.nextOffset}.`],
          '----- BEGIN CONTENT -----',
          value.content,
          '----- END CONTENT -----',
        ].join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return await runtime.read(args, exec.signal)
    },
  })

  const remove = defineTool({
    name: DELETE_TOOL,
    description: 'Delete a published artifact so its URL stops working. The id is never reused. '
      + 'Copies that others saved and the repository history remain; a repository created for the artifact is kept. The user may be asked to approve.',
    parameters: {
      id: { type: 'string', required: true, description: 'Artifact id to delete.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          url: { type: 'string', required: true },
          repository: { type: 'string', required: true },
          deleted: { type: 'boolean', required: true },
          commit: { type: 'string', required: true },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Deleted artifact ${value.id} from ${value.repository}; ${value.url} stops working once GitHub Pages redeploys (one to three minutes).`,
          ...value.notes.map(note => `Note: ${note}`),
        ].join('\n'),
      }],
      presentationMeta: (_args, value) => ({ url: value.url, id: value.id, deleted: true, repository: value.repository }),
    },
    async execute(args, exec) {
      return await runtime.remove(args, exec)
    },
  })

  const status = defineTool({
    name: STATUS_TOOL,
    description: 'Check the GitHub Pages artifact setup (token, repository, Pages settings) and the latest deployment. '
      + 'Pass id to check that artifact\'s repository and whether it is live; pass wait: true to wait up to five minutes until the latest change is deployed.',
    parameters: {
      id: { type: 'string', description: 'Artifact id whose repository and URL to check.' },
      wait: { type: 'boolean', description: 'Wait until the latest change is deployed (and the artifact URL responds); default false.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ready: { type: 'boolean', required: true },
          strategy: { ...STRATEGY, required: true },
          repository: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          siteUrl: { type: 'string' },
          token: {
            type: 'object', additionalProperties: false, required: true,
            properties: { configured: { type: 'boolean', required: true }, source: { type: 'string' } },
          },
          pages: { type: 'string', required: true },
          headCommit: { type: 'string' },
          deployed: { type: 'boolean' },
          latestBuild: {
            type: 'object', additionalProperties: false,
            properties: { status: { type: 'string', required: true }, commit: { type: 'string' }, error: { type: 'string' } },
          },
          artifact: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              url: { type: 'string', required: true },
              live: { type: 'boolean', required: true },
              httpStatus: { type: 'integer' },
            },
          },
          registryFile: { type: 'string', required: true },
          problems: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `${value.ready ? 'Ready' : 'Not ready'}: ${value.repository} (branch ${value.branch})${value.siteUrl === undefined ? '' : `, site ${value.siteUrl}`}; strategy ${value.strategy}`,
          `Token: ${value.token.configured ? `configured (${value.token.source ?? 'unknown source'})` : 'missing'}; Pages: ${value.pages}`,
          ...value.latestBuild === undefined ? [] : [`Latest Pages build: ${value.latestBuild.status}${value.latestBuild.commit === undefined ? '' : ` at ${value.latestBuild.commit.slice(0, 7)}`}`],
          ...value.deployed === undefined ? [] : [value.deployed ? 'Latest change: deployed' : 'Latest change: not deployed yet'],
          ...value.artifact === undefined ? [] : [`Artifact ${value.artifact.id}: ${value.artifact.live ? 'live' : 'not live yet'} at ${value.artifact.url}`],
          ...value.problems.map(problem => `Problem: ${problem}`),
        ].join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return await runtime.status(args, exec.signal)
    },
  })

  const repository = defineTool({
    name: REPOSITORY_TOOL,
    description: 'Show or change where new artifacts are published. '
      + 'Strategies: "shared" reuses one linked repository (each artifact gets a folder in it); "per-artifact" creates a new repository and Pages site for every new artifact. '
      + 'Actions: show (current settings); link (reuse an existing repository the user names, as owner/name or a remote URL such as https://github.com/owner/name.git; also selects the shared strategy); '
      + 'unlink (go back to the configured repository); set_strategy (shared or per-artifact). '
      + 'Only change settings when the user asks. Existing artifacts stay where they are.',
    parameters: {
      action: { type: 'string', required: true, enum: ['show', 'link', 'unlink', 'set_strategy'], description: 'What to do.' },
      repository: { type: 'string', description: 'For link: the repository as owner/name or a remote URL.' },
      strategy: { ...STRATEGY, description: 'For set_strategy: shared or per-artifact.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          strategy: { ...STRATEGY, required: true },
          strategySource: { type: 'string', enum: ['config', 'user'], required: true },
          repository: { type: 'string', required: true },
          repositorySource: { type: 'string', enum: ['linked', 'config', 'token user'], required: true },
          branch: { type: 'string', required: true },
          newRepositories: { type: 'string', required: true },
          siteUrl: { type: 'string' },
          pages: { type: 'string' },
          registryFile: { type: 'string', required: true },
          indexFile: { type: 'string', required: true },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: [
          ...args.action === 'show' ? [] : [`Done: ${args.action}.`],
          value.strategy === 'shared'
            ? `Strategy: shared (${value.strategySource === 'user' ? 'chosen by the user' : 'from the configuration'}). New artifacts go into ${value.repository} (${value.repositorySource}), branch ${value.branch}${value.siteUrl === undefined ? '' : `, site ${value.siteUrl}`}${value.pages === undefined ? '' : `, Pages ${value.pages}`}.`
            : `Strategy: per-artifact (${value.strategySource === 'user' ? 'chosen by the user' : 'from the configuration'}). Each new artifact gets a new repository: ${value.newRepositories}. The shared repository is ${value.repository} (${value.repositorySource}).`,
          `Published artifacts are tracked in ${value.registryFile}; index page: ${value.indexFile}`,
          ...value.warnings.map(warning => `Warning: ${warning}`),
        ].join('\n'),
      }],
    },
    async execute(args, exec) {
      return await runtime.repository(args, exec)
    },
  })

  return [publish, list, read, remove, status, repository]
}

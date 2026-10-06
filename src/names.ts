/** Tool names shared by the tool definitions, the runtime, and visibility rules. */

/** Tool that creates or updates an artifact. */
export const PUBLISH_TOOL = 'artifact_publish'
/** Tool that lists artifacts. */
export const LIST_TOOL = 'artifact_list'
/** Tool that reads an artifact back. */
export const READ_TOOL = 'artifact_read'
/** Tool that deletes an artifact. */
export const DELETE_TOOL = 'artifact_delete'
/** Tool that checks setup and deployment. */
export const STATUS_TOOL = 'artifact_status'
/** Tool that shows or changes where new artifacts go. */
export const REPOSITORY_TOOL = 'artifact_repository'

/** Every tool, in registration order. */
export const ALL_TOOLS = [PUBLISH_TOOL, LIST_TOOL, READ_TOOL, DELETE_TOOL, STATUS_TOOL, REPOSITORY_TOOL] as const
/** Tools that change what is published. */
export const MUTATING_TOOLS = [PUBLISH_TOOL, DELETE_TOOL] as const

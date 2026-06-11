import { claudeProvider } from './hook/claude/claude.js';

const CODEX_READING_TOOLS = new Set([
  'batch_get',
  'get_editor_state',
  'get_screenshot',
  'get_variables',
  'list_mcp_resource_templates',
  'list_mcp_resources',
  'read_mcp_resource',
  'snapshot_layout',
  'view_image',
]);

export const CODEX_SUBAGENT_TOOL_NAMES = new Set(['spawn_agent']);

export function getProviderCapabilities(): {
  readingTools: string[];
  subagentToolNames: string[];
} {
  return {
    readingTools: [...new Set([...claudeProvider.readingTools, ...CODEX_READING_TOOLS])],
    subagentToolNames: [
      ...new Set([...claudeProvider.subagentToolNames, ...CODEX_SUBAGENT_TOOL_NAMES]),
    ],
  };
}

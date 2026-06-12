const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { TEXT_IDLE_DELAY_MS, TOOL_DONE_DELAY_MS } from './constants.js';
import { CODEX_SUBAGENT_TOOL_NAMES } from './providers/capabilities.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  startWaitingTimer,
} from './timerManager.js';
import type { AgentState } from './types.js';

/** Empty set used as safe fallback when no HookProvider is registered. */
const EMPTY_EXEMPT_TOOLS: ReadonlySet<string> = new Set();

/** Hook provider: supplies formatToolStatus + team.extractTeamMetadataFromRecord.
 *  Registered once at startup via setHookProvider(). Functions below assume it's set. */
let hookProvider: HookProvider | null = null;

/** Permission-exempt tools come from the active provider. Fail-open if unset. */
function exemptTools(): ReadonlySet<string> {
  return hookProvider?.permissionExemptTools ?? EMPTY_EXEMPT_TOOLS;
}

/** Whether the given tool name spawns a sub-agent according to the active provider. */
function isSubagentTool(toolName: string | null | undefined): boolean {
  if (!toolName || !hookProvider) return false;
  return hookProvider.subagentToolNames.has(toolName);
}

function isCodexSubagentTool(toolName: string | null | undefined): boolean {
  return typeof toolName === 'string' && CODEX_SUBAGENT_TOOL_NAMES.has(toolName);
}

/** Register the HookProvider that owns CLI-specific formatting and team metadata extraction. */
export function setHookProvider(provider: HookProvider): void {
  hookProvider = provider;
}

/** Format a tool status line. Delegates to the active HookProvider's formatToolStatus.
 *  Invariant: a provider is registered before any transcript lines are parsed. */
export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  return hookProvider?.formatToolStatus(toolName, input) ?? `Using ${toolName}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCodexSessionMetaRecord(record: Record<string, unknown>): boolean {
  if (record.type !== 'session_meta' || !isRecord(record.payload)) {
    return false;
  }

  return typeof record.payload.id === 'string';
}

const CODEX_THINKING_TOOL_NAME = 'codex_thinking';
const CODEX_WRITING_TOOL_NAME = 'codex_message';
const CODEX_WEB_SEARCH_TOOL_NAME = 'web_search';

function parseCodexArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;

  if (typeof value !== 'string' || value.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function shortCommandToken(value: string | undefined): string | null {
  if (!value) return null;

  const normalized = value
    .replace(/^['"]|['"]$/g, '')
    .replace(/^\.?[\\/]/, '')
    .replace(/\.(cmd|exe|ps1)$/i, '');
  const parts = normalized.split(/[\\/]/);
  const token = parts[parts.length - 1]?.trim();

  return token || null;
}

function formatShellCommandStatus(commandValue: unknown): string {
  if (typeof commandValue !== 'string') return 'Running command';

  const command = commandValue.trim().replace(/\s+/g, ' ');
  if (!command) return 'Running command';

  const lower = command.toLowerCase();

  if (lower.startsWith('$')) return 'Running PowerShell command';
  if (/\brg(\.exe)?\b/.test(lower) || lower.includes('select-string')) return 'Searching files';
  if (/^(get-content|cat|type)\b/i.test(command)) return 'Reading files';
  if (/\bgit\s+status\b/.test(lower)) return 'Checking git status';
  if (/\bgit\s+diff\b/.test(lower)) return 'Reviewing git diff';
  if (/\bgit\s+log\b/.test(lower) || /\bgit\s+show\b/.test(lower)) return 'Reading git history';
  if (/\bnpm\s+run\s+([^\s]+)/i.test(command)) {
    const script = command.match(/\bnpm\s+run\s+([^\s]+)/i)?.[1];
    return script ? `Running npm run ${script}` : 'Running npm script';
  }
  if (/\bnpm\s+(install|ci)\b/i.test(command)) return 'Installing npm dependencies';

  const firstSegment = command.split(/[|;&]/)[0]?.trim() ?? command;
  const tokens = firstSegment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const executable = shortCommandToken(tokens[0]);
  const subcommand = shortCommandToken(tokens[1]);

  if (!executable) return 'Running command';
  if (executable.toLowerCase().includes('powershell') || executable.toLowerCase() === 'pwsh') {
    return 'Running PowerShell command';
  }

  return subcommand ? `Running ${executable} ${subcommand}` : `Running ${executable}`;
}

function formatCodexToolStatus(toolName: string, args: Record<string, unknown> = {}): string {
  switch (toolName) {
    case 'shell_command':
      return formatShellCommandStatus(args.command);
    case 'apply_patch':
      return 'Editing files';
    case 'spawn_agent':
      return typeof args.agent_type === 'string' && args.agent_type.trim()
        ? `Subtask: ${args.agent_type.trim()} agent`
        : 'Subtask: Codex agent';
    case 'wait_agent':
      return 'Waiting for agents';
    case 'close_agent':
      return 'Closing agent';
    case 'send_input':
      return 'Messaging agent';
    case 'tool_search':
      return 'Searching tools';
    case 'web_search':
      return 'Searching web';
    case 'js':
      return typeof args.title === 'string' && args.title.trim()
        ? `Running ${args.title.trim()}`
        : 'Running JavaScript';
    case 'get_screenshot':
      return 'Capturing screenshot';
    case 'view_image':
      return 'Viewing image';
    default:
      return `Using ${toolName}`;
  }
}

function hasRealCodexToolActivity(agent: AgentState): boolean {
  for (const toolId of agent.activeToolIds) {
    if (toolId !== agent.codexSyntheticToolId) return true;
  }

  return false;
}

function clearCodexSyntheticActivity(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
): void {
  const toolId = agent.codexSyntheticToolId;
  if (!toolId) return;

  agent.codexSyntheticToolId = undefined;
  agent.activeToolIds.delete(toolId);
  agent.activeToolStatuses.delete(toolId);
  agent.activeToolNames.delete(toolId);
  agents.broadcast({ type: 'agentToolDone', id: agentId, toolId });
}

function startCodexSyntheticActivity(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  status: string,
  toolName: string,
): void {
  if (hasRealCodexToolActivity(agent)) return;

  agent.codexTurnCompletedAt = undefined;
  const currentToolId = agent.codexSyntheticToolId;
  if (currentToolId && agent.activeToolStatuses.get(currentToolId) === status) {
    return;
  }

  clearCodexSyntheticActivity(agentId, agent, agents);

  const toolId = `codex:${toolName}:${agent.linesProcessed}`;
  agent.codexSyntheticToolId = toolId;
  agent.activeToolIds.add(toolId);
  agent.activeToolStatuses.set(toolId, status);
  agent.activeToolNames.set(toolId, toolName);
  agent.isWaiting = false;

  agents.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
  agents.broadcast({
    type: 'agentToolStart',
    id: agentId,
    toolId,
    status,
    toolName,
    permissionActive: false,
  });
}

function processCodexTranscriptRecord(
  agentId: number,
  record: Record<string, unknown>,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
): boolean {
  const agent = agents.get(agentId);
  if (!agent) return true;

  if (agent.providerId !== 'codex' && !isCodexSessionMetaRecord(record)) {
    return false;
  }

  if (record.type === 'session_meta') {
    const payload = record.payload as
      | {
          agent_nickname?: string;
          agent_role?: string;
        }
      | undefined;

    agent.providerId = 'codex';
    if (payload?.agent_nickname || payload?.agent_role) {
      agent.folderName = payload.agent_nickname
        ? payload.agent_role
          ? `${payload.agent_nickname} (${payload.agent_role})`
          : payload.agent_nickname
        : payload.agent_role;
      agent.teamName = 'Codex';
      agent.agentName = payload.agent_role;
      agents.broadcast({
        type: 'agentTeamInfo',
        id: agentId,
        teamName: agent.teamName,
        agentName: agent.agentName,
      });
    }

    return true;
  }

  if (record.type === 'event_msg') {
    const payload = record.payload as { type?: string } | undefined;

    if (payload?.type === 'task_started') {
      cancelWaitingTimer(agentId, waitingTimers);
      agent.isWaiting = false;
      agent.codexTurnCompletedAt = undefined;
      agents.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
      startCodexSyntheticActivity(agentId, agent, agents, 'Thinking', CODEX_THINKING_TOOL_NAME);
    } else if (payload?.type === 'agent_message') {
      cancelWaitingTimer(agentId, waitingTimers);
      startCodexSyntheticActivity(
        agentId,
        agent,
        agents,
        'Writing response',
        CODEX_WRITING_TOOL_NAME,
      );
    } else if (payload?.type === 'task_complete') {
      clearCodexSyntheticActivity(agentId, agent, agents);
      agent.codexTurnCompletedAt = Date.now();
      agent.isWaiting = true;
      agents.broadcast({ type: 'agentStatus', id: agentId, status: 'waiting' });
    } else if (payload?.type === 'web_search_end') {
      if (
        agent.codexSyntheticToolId &&
        agent.activeToolNames.get(agent.codexSyntheticToolId) === CODEX_WEB_SEARCH_TOOL_NAME
      ) {
        clearCodexSyntheticActivity(agentId, agent, agents);
      }
    } else if (payload?.type === 'turn_aborted') {
      clearCodexSyntheticActivity(agentId, agent, agents);
      agent.codexTurnCompletedAt = Date.now();
      agent.isWaiting = true;
      agents.broadcast({ type: 'agentStatus', id: agentId, status: 'waiting' });
    }

    return true;
  }

  if (record.type !== 'response_item') {
    return false;
  }

  const payload = record.payload as
    | {
        type?: string;
        name?: string;
        call_id?: string;
        arguments?: unknown;
        input?: unknown;
      }
    | undefined;

  if (!payload?.type) return true;

  if (
    (payload.type === 'function_call' || payload.type === 'custom_tool_call') &&
    payload.name &&
    payload.call_id
  ) {
    const toolName = payload.name;
    const toolId = payload.call_id;
    const args = parseCodexArguments(payload.arguments ?? payload.input);
    const status = formatCodexToolStatus(toolName, args);

    clearCodexSyntheticActivity(agentId, agent, agents);
    agent.codexTurnCompletedAt = undefined;
    cancelWaitingTimer(agentId, waitingTimers);
    agent.isWaiting = false;
    agent.hadToolsInTurn = true;
    agent.activeToolIds.add(toolId);
    agent.activeToolStatuses.set(toolId, status);
    agent.activeToolNames.set(toolId, toolName);
    if (isCodexSubagentTool(toolName)) {
      agent.activeSubagentToolIds.set(toolId, new Set());
      agent.activeSubagentToolNames.set(toolId, new Map());
    }

    agents.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
    agents.broadcast({
      type: 'agentToolStart',
      id: agentId,
      toolId,
      status,
      toolName,
      permissionActive: false,
    });

    return true;
  }

  if (payload.type === 'tool_search_call' && payload.call_id) {
    const toolName = 'tool_search';
    const toolId = payload.call_id;
    const status = formatCodexToolStatus(toolName, parseCodexArguments(payload.arguments));

    clearCodexSyntheticActivity(agentId, agent, agents);
    agent.codexTurnCompletedAt = undefined;
    cancelWaitingTimer(agentId, waitingTimers);
    agent.isWaiting = false;
    agent.hadToolsInTurn = true;
    agent.activeToolIds.add(toolId);
    agent.activeToolStatuses.set(toolId, status);
    agent.activeToolNames.set(toolId, toolName);

    agents.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
    agents.broadcast({
      type: 'agentToolStart',
      id: agentId,
      toolId,
      status,
      toolName,
      permissionActive: false,
    });

    return true;
  }

  if (payload.type === 'web_search_call') {
    startCodexSyntheticActivity(
      agentId,
      agent,
      agents,
      formatCodexToolStatus(CODEX_WEB_SEARCH_TOOL_NAME),
      CODEX_WEB_SEARCH_TOOL_NAME,
    );
    return true;
  }

  if (
    (payload.type === 'function_call_output' ||
      payload.type === 'custom_tool_call_output' ||
      payload.type === 'tool_search_output') &&
    payload.call_id
  ) {
    const toolId = payload.call_id;
    const toolName = agent.activeToolNames.get(toolId);

    if (isCodexSubagentTool(toolName)) {
      agent.activeSubagentToolIds.delete(toolId);
      agent.activeSubagentToolNames.delete(toolId);
      agents.broadcast({
        type: 'subagentClear',
        id: agentId,
        parentToolId: toolId,
      });
    }

    agent.activeToolIds.delete(toolId);
    agent.activeToolStatuses.delete(toolId);
    agent.activeToolNames.delete(toolId);

    setTimeout(() => {
      agents.broadcast({
        type: 'agentToolDone',
        id: agentId,
        toolId,
      });
    }, TOOL_DONE_DELAY_MS);

    if (agent.activeToolIds.size === 0) {
      agent.hadToolsInTurn = false;
    }

    return true;
  }

  if (payload.type === 'reasoning') {
    startCodexSyntheticActivity(agentId, agent, agents, 'Thinking', CODEX_THINKING_TOOL_NAME);
    return true;
  }

  if (payload.type === 'message') {
    startCodexSyntheticActivity(
      agentId,
      agent,
      agents,
      'Writing response',
      CODEX_WRITING_TOOL_NAME,
    );
    return true;
  }

  return false;
}

export function processTranscriptLine(
  agentId: number,
  line: string,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  agent.lastDataAt = Date.now();
  agent.linesProcessed++;
  try {
    const record = JSON.parse(line);
    if (processCodexTranscriptRecord(agentId, record, agents, waitingTimers)) {
      return;
    }

    // -- Agent Teams: extract team metadata via the active provider --
    // The provider reads its CLI's own field names (Claude: record.teamName + record.agentName).
    // Other CLIs would implement this differently or not at all.
    const teamMeta = hookProvider?.team?.extractTeamMetadataFromRecord(record);
    if (teamMeta?.teamName && teamMeta.teamName !== agent.teamName) {
      agent.teamName = teamMeta.teamName;
      agent.agentName = teamMeta.agentName;
      agent.isTeamLead = undefined;
      agent.leadAgentId = undefined;
      if (debug) {
        console.log(
          `[Pixel Agents] Agent ${agentId} team metadata: team=${agent.teamName}, role=${agent.agentName ?? 'lead'}`,
        );
      }
      // Link teammates to leads within the same team
      linkTeammates(agentId, agent, agents);

      agents.broadcast({
        type: 'agentTeamInfo',
        id: agentId,
        teamName: agent.teamName,
        agentName: agent.agentName,
        isTeamLead: agent.isTeamLead,
        leadAgentId: agent.leadAgentId,
      });
    }

    // -- Token usage extraction from assistant records --
    const usage = record.message?.usage as
      | { input_tokens?: number; output_tokens?: number }
      | undefined;
    if (usage) {
      if (typeof usage.input_tokens === 'number') {
        agent.inputTokens += usage.input_tokens;
      }
      if (typeof usage.output_tokens === 'number') {
        agent.outputTokens += usage.output_tokens;
      }
      agents.broadcast({
        type: 'agentTokenUsage',
        id: agentId,
        inputTokens: agent.inputTokens,
        outputTokens: agent.outputTokens,
      });
    }

    // Resilient content extraction: support both record.message.content and record.content
    // Claude Code may change the JSONL structure across versions
    const assistantContent = record.message?.content ?? record.content;

    if (record.type === 'assistant' && Array.isArray(assistantContent)) {
      const blocks = assistantContent as Array<{
        type: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      const hasToolUse = blocks.some((b) => b.type === 'tool_use');

      if (hasToolUse) {
        cancelWaitingTimer(agentId, waitingTimers);
        agent.isWaiting = false;
        agent.hadToolsInTurn = true;
        agents.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
        let hasNonExemptTool = false;
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id) {
            const toolName = block.name || '';
            const status = formatToolStatus(toolName, block.input || {});
            console.log(
              `[Pixel Agents] JSONL: Agent ${agentId} - tool start: ${block.id} ${status}`,
            );
            agent.activeToolIds.add(block.id);
            agent.activeToolStatuses.set(block.id, status);
            agent.activeToolNames.set(block.id, toolName);
            if (!exemptTools().has(toolName)) {
              hasNonExemptTool = true;
            }
            // Detect tmux vs inline team mode from the team provider's spawn predicate.
            if (
              agent.teamName &&
              hookProvider?.team?.isTeammateSpawnCall(toolName, block.input ?? {}) &&
              !agent.teamUsesTmux
            ) {
              agent.teamUsesTmux = true;
              agents.broadcast({
                type: 'agentTeamInfo',
                id: agentId,
                teamName: agent.teamName,
                agentName: agent.agentName,
                isTeamLead: agent.isTeamLead,
                leadAgentId: agent.leadAgentId,
                teamUsesTmux: true,
              });
            }
            // Skip webview message when hooks handle tool visuals (PreToolUse sent it instantly).
            // EXCEPTION: subagent-spawn tools (Task/Agent) ALWAYS use JSONL so the sub-agent
            // character is created with the REAL tool id. SubagentStop and subagentClear use
            // the real id -- a synthetic-id sub-agent from PreToolUse could never be matched.
            const isSubagentSpawn = isSubagentTool(toolName);
            if (!agent.hookDelivered || isSubagentSpawn) {
              const runInBackground = isSubagentSpawn && block.input?.run_in_background === true;
              agents.broadcast({
                type: 'agentToolStart',
                id: agentId,
                toolId: block.id,
                status,
                toolName,
                permissionActive: agent.permissionSent,
                runInBackground,
              });
            }
          }
        }
        // Skip heuristic timer when hooks are active OR for teammates.
        // Teammate tools (WebFetch, WebSearch) are naturally slow; the heuristic
        // produces false positives. Permission on teammates comes from the lead's
        // routed Notification(permission_prompt) hook — slower but accurate.
        if (hasNonExemptTool && !agent.hookDelivered && !agent.leadAgentId) {
          startPermissionTimer(agentId, agents, permissionTimers, exemptTools());
        }
      } else if (blocks.some((b) => b.type === 'text') && !agent.hadToolsInTurn) {
        // Text-only response in a turn that hasn't used any tools.
        // turn_duration handles tool-using turns reliably but is never
        // emitted for text-only turns, so we use a silence-based timer:
        // if no new JSONL data arrives within TEXT_IDLE_DELAY_MS, mark as waiting.
        // Skip when hooks are active — Stop hook handles this exactly.
        if (!agent.hookDelivered) {
          startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers);
        }
      }
    } else if (record.type === 'assistant' && typeof assistantContent === 'string') {
      // Text-only assistant response (content is a string, not an array)
      if (!agent.hadToolsInTurn && !agent.hookDelivered) {
        startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers);
      }
    } else if (record.type === 'assistant' && assistantContent === undefined) {
      // Assistant record with no recognizable content structure
      console.warn(
        `[Pixel Agents] Agent ${agentId}: assistant record has no content. Keys: ${Object.keys(record).join(', ')}`,
      );
    } else if (record.type === 'progress') {
      processProgressRecord(agentId, record, agents, waitingTimers, permissionTimers);
    } else if (record.type === 'user') {
      const content = record.message?.content ?? record.content;
      if (Array.isArray(content)) {
        const blocks = content as Array<{ type: string; tool_use_id?: string }>;
        const hasToolResult = blocks.some((b) => b.type === 'tool_result');
        if (hasToolResult) {
          for (const block of blocks) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const completedToolId = block.tool_use_id;
              const completedToolName = agent.activeToolNames.get(completedToolId);

              // Detect background agent launches — keep the tool alive until queue-operation
              if (isSubagentTool(completedToolName) && isAsyncAgentResult(block)) {
                console.log(
                  `[Pixel Agents] Agent ${agentId} background agent launched: ${completedToolId}`,
                );
                agent.backgroundAgentToolIds.add(completedToolId);
                continue; // don't mark as done yet
              }

              console.log(
                `[Pixel Agents] JSONL: Agent ${agentId} - tool done: ${block.tool_use_id}`,
              );
              // If the completed tool spawned a subagent, clear its subagent tools
              if (isSubagentTool(completedToolName)) {
                agent.activeSubagentToolIds.delete(completedToolId);
                agent.activeSubagentToolNames.delete(completedToolId);
                agents.broadcast({
                  type: 'subagentClear',
                  id: agentId,
                  parentToolId: completedToolId,
                });
              }
              agent.activeToolIds.delete(completedToolId);
              agent.activeToolStatuses.delete(completedToolId);
              agent.activeToolNames.delete(completedToolId);
              // Send agentToolDone when hooks are off, or for Task/Agent tools
              // (which always use JSONL path for consistent sub-agent lifecycle).
              const isCompletedAgentTool =
                completedToolName === 'Task' || completedToolName === 'Agent';
              if (!agent.hookDelivered || isCompletedAgentTool) {
                const toolId = completedToolId;
                setTimeout(() => {
                  agents.broadcast({
                    type: 'agentToolDone',
                    id: agentId,
                    toolId,
                  });
                }, TOOL_DONE_DELAY_MS);
              }
            }
          }
          // All tools completed — allow text-idle timer as fallback
          // for turn-end detection when turn_duration is not emitted
          if (agent.activeToolIds.size === 0) {
            agent.hadToolsInTurn = false;
          }
        } else {
          // New user text prompt — new turn starting
          cancelWaitingTimer(agentId, waitingTimers);
          clearAgentActivity(agent, agentId, agents, permissionTimers);
          agent.hadToolsInTurn = false;
        }
      } else if (typeof content === 'string' && content.trim()) {
        // New user text prompt — new turn starting
        cancelWaitingTimer(agentId, waitingTimers);
        clearAgentActivity(agent, agentId, agents, permissionTimers);
        agent.hadToolsInTurn = false;
      }
    } else if (record.type === 'queue-operation' && record.operation === 'enqueue') {
      // Background agent completed — parse tool-use-id from XML content
      const content = record.content as string | undefined;
      if (content) {
        const toolIdMatch = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
        if (toolIdMatch) {
          const completedToolId = toolIdMatch[1];
          if (agent.backgroundAgentToolIds.has(completedToolId)) {
            console.log(
              `[Pixel Agents] Agent ${agentId} background agent done: ${completedToolId}`,
            );
            agent.backgroundAgentToolIds.delete(completedToolId);
            agent.activeSubagentToolIds.delete(completedToolId);
            agent.activeSubagentToolNames.delete(completedToolId);
            agents.broadcast({
              type: 'subagentClear',
              id: agentId,
              parentToolId: completedToolId,
            });
            agent.activeToolIds.delete(completedToolId);
            agent.activeToolStatuses.delete(completedToolId);
            agent.activeToolNames.delete(completedToolId);
            if (!agent.hookDelivered) {
              const toolId = completedToolId;
              setTimeout(() => {
                agents.broadcast({
                  type: 'agentToolDone',
                  id: agentId,
                  toolId,
                });
              }, TOOL_DONE_DELAY_MS);
            }
          }
        }
      }
    } else if (record.type === 'system' && record.subtype === 'turn_duration') {
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);

      // Definitive turn-end: clean up any stale tool state, but preserve background agents.
      // When hooks are active, the Stop hook already handled the status change,
      // but we still perform state cleanup here as a safety net.
      const hasForegroundTools = agent.activeToolIds.size > agent.backgroundAgentToolIds.size;
      if (hasForegroundTools) {
        // Remove only non-background tool state
        for (const toolId of agent.activeToolIds) {
          if (agent.backgroundAgentToolIds.has(toolId)) continue;
          agent.activeToolIds.delete(toolId);
          agent.activeToolStatuses.delete(toolId);
          const toolName = agent.activeToolNames.get(toolId);
          agent.activeToolNames.delete(toolId);
          if (isSubagentTool(toolName)) {
            agent.activeSubagentToolIds.delete(toolId);
            agent.activeSubagentToolNames.delete(toolId);
          }
        }
        if (!agent.hookDelivered) {
          agents.broadcast({ type: 'agentToolsClear', id: agentId });
        }
        // Re-send background agent tools so webview keeps their sub-agents alive
        for (const toolId of agent.backgroundAgentToolIds) {
          const status = agent.activeToolStatuses.get(toolId);
          if (status) {
            agents.broadcast({
              type: 'agentToolStart',
              id: agentId,
              toolId,
              status,
            });
          }
        }
      } else if (agent.activeToolIds.size > 0 && agent.backgroundAgentToolIds.size === 0) {
        agent.activeToolIds.clear();
        agent.activeToolStatuses.clear();
        agent.activeToolNames.clear();
        agent.activeSubagentToolIds.clear();
        agent.activeSubagentToolNames.clear();
        if (!agent.hookDelivered) {
          agents.broadcast({ type: 'agentToolsClear', id: agentId });
        }
      }

      agent.isWaiting = true;
      agent.permissionSent = false;
      agent.hadToolsInTurn = false;
      // Skip status post when hooks already handled it
      if (!agent.hookDelivered) {
        agents.broadcast({
          type: 'agentStatus',
          id: agentId,
          status: 'waiting',
        });
      }
    } else if (record.type && !agent.seenUnknownRecordTypes.has(record.type)) {
      // Log first occurrence of unrecognized record types to help diagnose issues
      // where Claude Code changes JSONL format. Known types we intentionally skip:
      // file-history-snapshot, queue-operation (non-enqueue), etc.
      const knownSkippableTypes = new Set(['file-history-snapshot', 'system', 'queue-operation']);
      if (!knownSkippableTypes.has(record.type)) {
        agent.seenUnknownRecordTypes.add(record.type);
        if (debug) {
          console.log(
            `[Pixel Agents] JSONL: Agent ${agentId} - unrecognized record type '${record.type}'. ` +
              `Keys: ${Object.keys(record).join(', ')}`,
          );
        }
      }
    }
  } catch {
    // Ignore malformed lines
  }
}

function processProgressRecord(
  agentId: number,
  record: Record<string, unknown>,
  agents: AgentStateStore,
  _waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  const parentToolId = record.parentToolUseID as string | undefined;
  if (!parentToolId) return;

  const data = record.data as Record<string, unknown> | undefined;
  if (!data) return;

  // bash_progress / mcp_progress: tool is actively executing, not stuck on permission.
  // Restart the permission timer to give the running tool another window.
  // Skip when hooks are active — Notification hook handles permission detection exactly.
  const dataType = data.type as string | undefined;
  if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
    if (agent.activeToolIds.has(parentToolId) && !agent.hookDelivered && !agent.leadAgentId) {
      startPermissionTimer(agentId, agents, permissionTimers, exemptTools());
    }
    return;
  }

  // Verify parent is an active subagent-spawning tool (agent_progress handling)
  const parentToolName = agent.activeToolNames.get(parentToolId);
  if (!isSubagentTool(parentToolName)) return;

  const msg = data.message as Record<string, unknown> | undefined;
  if (!msg) return;

  const msgType = msg.type as string;
  const innerMsg = msg.message as Record<string, unknown> | undefined;
  const content = innerMsg?.content;
  if (!Array.isArray(content)) return;

  if (msgType === 'assistant') {
    let hasNonExemptSubTool = false;
    for (const block of content) {
      if (block.type === 'tool_use' && block.id) {
        const toolName = block.name || '';
        const status = formatToolStatus(toolName, block.input || {});
        console.log(
          `[Pixel Agents] Agent ${agentId} subagent tool start: ${block.id} ${status} (parent: ${parentToolId})`,
        );

        // Track sub-tool IDs
        let subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (!subTools) {
          subTools = new Set();
          agent.activeSubagentToolIds.set(parentToolId, subTools);
        }
        subTools.add(block.id);

        // Track sub-tool names (for permission checking)
        let subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (!subNames) {
          subNames = new Map();
          agent.activeSubagentToolNames.set(parentToolId, subNames);
        }
        subNames.set(block.id, toolName);

        if (!exemptTools().has(toolName)) {
          hasNonExemptSubTool = true;
        }

        agents.broadcast({
          type: 'subagentToolStart',
          id: agentId,
          parentToolId,
          toolId: block.id,
          status,
        });
      }
    }
    if (hasNonExemptSubTool && !agent.hookDelivered) {
      startPermissionTimer(agentId, agents, permissionTimers, exemptTools());
    }
  } else if (msgType === 'user') {
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        console.log(
          `[Pixel Agents] Agent ${agentId} subagent tool done: ${block.tool_use_id} (parent: ${parentToolId})`,
        );

        // Remove from tracking
        const subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (subTools) {
          subTools.delete(block.tool_use_id);
        }
        const subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (subNames) {
          subNames.delete(block.tool_use_id);
        }

        const toolId = block.tool_use_id;
        setTimeout(() => {
          agents.broadcast({
            type: 'subagentToolDone',
            id: agentId,
            parentToolId,
            toolId,
          });
        }, 300);
      }
    }
    // If there are still active non-exempt sub-agent tools, restart the permission timer
    // (handles the case where one sub-agent completes but another is still stuck)
    let stillHasNonExempt = false;
    for (const [, subNames] of agent.activeSubagentToolNames) {
      for (const [, toolName] of subNames) {
        if (!exemptTools().has(toolName)) {
          stillHasNonExempt = true;
          break;
        }
      }
      if (stillHasNonExempt) break;
    }
    if (stillHasNonExempt && !agent.hookDelivered) {
      startPermissionTimer(agentId, agents, permissionTimers, exemptTools());
    }
  }
}

/**
 * Link teammates within the same team.
 * The lead is the agent with no agentName (or the first one detected in the team).
 * Teammates get leadAgentId pointing to the lead.
 */
function linkTeammates(_agentId: number, agent: AgentState, agents: AgentStateStore): void {
  const teamName = agent.teamName;
  if (!teamName) return;

  // Find all agents in this team
  const teamAgents: AgentState[] = [];
  for (const a of agents.values()) {
    if (a.teamName === teamName) {
      teamAgents.push(a);
    }
  }

  // Determine lead: always prefer the agent WITHOUT agentName (the real lead has agentName=null).
  // This handles the case where a teammate is detected first and temporarily marked as lead,
  // then the real lead joins later.
  let lead: AgentState | undefined;
  for (const a of teamAgents) {
    if (!a.agentName) {
      lead = a;
      break;
    }
  }
  if (!lead) {
    // No agent without agentName -- use existing isTeamLead or first agent
    for (const a of teamAgents) {
      if (a.isTeamLead) {
        lead = a;
        break;
      }
    }
  }
  if (!lead) {
    lead = teamAgents[0];
  }

  // Update all team members: mark lead, clear stale lead flags, link teammates
  for (const a of teamAgents) {
    if (a.id === lead.id) {
      a.isTeamLead = true;
      a.leadAgentId = undefined;
    } else {
      a.isTeamLead = false;
      a.leadAgentId = lead.id;
    }
  }
}

/** Check if a tool_result block indicates an async/background agent launch */
function isAsyncAgentResult(block: Record<string, unknown>): boolean {
  const content = block.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).text === 'string' &&
        ((item as Record<string, unknown>).text as string).startsWith(
          'Async agent launched successfully.',
        )
      ) {
        return true;
      }
    }
  } else if (typeof content === 'string') {
    return content.startsWith('Async agent launched successfully.');
  }
  return false;
}

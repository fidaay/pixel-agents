import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { TOOL_DONE_DELAY_MS } from '../src/constants.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

function createAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'codex-session',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/project',
    jsonlFile: '/project/rollout.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

function setupStore(agent: AgentState): {
  broadcasts: Record<string, unknown>[];
  store: AgentStateStore;
} {
  const store = new AgentStateStore();
  const broadcasts: Record<string, unknown>[] = [];
  store.on('broadcast', (message) => broadcasts.push(message));
  store.set(agent.id, agent);

  return { broadcasts, store };
}

describe('Codex transcript parsing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps Codex function calls to active tool state', () => {
    vi.useFakeTimers();

    const agent = createAgent({ providerId: 'codex' });
    const { broadcasts, store } = setupStore(agent);
    const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

    processTranscriptLine(
      agent.id,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell_command',
          call_id: 'call-1',
          arguments: JSON.stringify({ command: 'git status --short --branch' }),
        },
      }),
      store,
      waitingTimers,
      permissionTimers,
    );

    expect(agent.activeToolIds.has('call-1')).toBe(true);
    expect(agent.activeToolStatuses.get('call-1')).toBe('Checking git status');
    expect(broadcasts).toContainEqual({ type: 'agentStatus', id: agent.id, status: 'active' });
    expect(broadcasts).toContainEqual({
      type: 'agentToolStart',
      id: agent.id,
      toolId: 'call-1',
      status: 'Checking git status',
      toolName: 'shell_command',
      permissionActive: false,
    });

    processTranscriptLine(
      agent.id,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1' },
      }),
      store,
      waitingTimers,
      permissionTimers,
    );

    expect(agent.activeToolIds.has('call-1')).toBe(false);

    vi.advanceTimersByTime(TOOL_DONE_DELAY_MS);
    expect(broadcasts).toContainEqual({
      type: 'agentToolDone',
      id: agent.id,
      toolId: 'call-1',
    });
  });

  it('shows Codex reasoning and message records as synthetic activity', () => {
    const agent = createAgent({ providerId: 'codex' });
    const { broadcasts, store } = setupStore(agent);

    processTranscriptLine(
      agent.id,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'reasoning', summary: [] },
      }),
      store,
      new Map(),
      new Map(),
    );

    const thinkingToolId = agent.codexSyntheticToolId;

    expect(thinkingToolId).toBeTruthy();
    expect(agent.activeToolStatuses.get(thinkingToolId!)).toBe('Thinking');
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'agentToolStart',
        status: 'Thinking',
        toolName: 'codex_thinking',
      }),
    );

    processTranscriptLine(
      agent.id,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
      }),
      store,
      new Map(),
      new Map(),
    );

    expect(broadcasts).toContainEqual({
      type: 'agentToolDone',
      id: agent.id,
      toolId: thinkingToolId,
    });
    expect(agent.activeToolStatuses.get(agent.codexSyntheticToolId!)).toBe('Writing response');
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'agentToolStart',
        status: 'Writing response',
        toolName: 'codex_message',
      }),
    );
  });

  it('clears Codex synthetic activity when the turn completes', () => {
    const agent = createAgent({ providerId: 'codex' });
    const { broadcasts, store } = setupStore(agent);

    processTranscriptLine(
      agent.id,
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started' },
      }),
      store,
      new Map(),
      new Map(),
    );

    const thinkingToolId = agent.codexSyntheticToolId;
    expect(agent.activeToolStatuses.get(thinkingToolId!)).toBe('Thinking');

    processTranscriptLine(
      agent.id,
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete' },
      }),
      store,
      new Map(),
      new Map(),
    );

    expect(agent.codexSyntheticToolId).toBeUndefined();
    expect(agent.codexTurnCompletedAt).toBeGreaterThan(0);
    expect(agent.isWaiting).toBe(true);
    expect(broadcasts).toContainEqual({
      type: 'agentToolDone',
      id: agent.id,
      toolId: thinkingToolId,
    });
    expect(broadcasts).toContainEqual({ type: 'agentStatus', id: agent.id, status: 'waiting' });

    processTranscriptLine(
      agent.id,
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started' },
      }),
      store,
      new Map(),
      new Map(),
    );

    expect(agent.codexTurnCompletedAt).toBeUndefined();
  });

  it('maps Codex custom tools and tool search calls to concrete statuses', () => {
    const agent = createAgent({ providerId: 'codex' });
    const { broadcasts, store } = setupStore(agent);

    processTranscriptLine(
      agent.id,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'patch-1',
          input: '*** Begin Patch\n*** End Patch',
        },
      }),
      store,
      new Map(),
      new Map(),
    );

    processTranscriptLine(
      agent.id,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'tool_search_call',
          call_id: 'search-1',
          arguments: JSON.stringify({ query: 'spawn agent' }),
        },
      }),
      store,
      new Map(),
      new Map(),
    );

    expect(agent.activeToolStatuses.get('patch-1')).toBe('Editing files');
    expect(agent.activeToolStatuses.get('search-1')).toBe('Searching tools');
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'agentToolStart',
        toolId: 'patch-1',
        status: 'Editing files',
        toolName: 'apply_patch',
      }),
    );
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'agentToolStart',
        toolId: 'search-1',
        status: 'Searching tools',
        toolName: 'tool_search',
      }),
    );
  });

  it('does not treat non-Codex response_item records as Codex tool calls', () => {
    const agent = createAgent();
    const { broadcasts, store } = setupStore(agent);

    processTranscriptLine(
      agent.id,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell_command', call_id: 'call-1' },
      }),
      store,
      new Map(),
      new Map(),
    );

    expect(agent.providerId).toBeUndefined();
    expect(agent.activeToolIds.size).toBe(0);
    expect(broadcasts).not.toContainEqual(
      expect.objectContaining({ type: 'agentToolStart', toolId: 'call-1' }),
    );
  });

  it('clears Codex spawn_agent subagent state when the tool finishes', () => {
    const agent = createAgent({ providerId: 'codex' });
    const { broadcasts, store } = setupStore(agent);

    processTranscriptLine(
      agent.id,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-1' },
      }),
      store,
      new Map(),
      new Map(),
    );

    expect(agent.activeSubagentToolIds.has('spawn-1')).toBe(true);
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'agentToolStart',
        toolId: 'spawn-1',
        status: 'Subtask: Codex agent',
        toolName: 'spawn_agent',
      }),
    );

    processTranscriptLine(
      agent.id,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'spawn-1' },
      }),
      store,
      new Map(),
      new Map(),
    );

    expect(agent.activeSubagentToolIds.has('spawn-1')).toBe(false);
    expect(broadcasts).toContainEqual({
      type: 'subagentClear',
      id: agent.id,
      parentToolId: 'spawn-1',
    });
  });

  it('adopts Codex session metadata and broadcasts team info', () => {
    const agent = createAgent();
    const { broadcasts, store } = setupStore(agent);

    processTranscriptLine(
      agent.id,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'session-1',
          agent_nickname: 'Boole',
          agent_role: 'reviewer',
        },
      }),
      store,
      new Map(),
      new Map(),
    );

    expect(agent.providerId).toBe('codex');
    expect(agent.folderName).toBe('Boole (reviewer)');
    expect(agent.teamName).toBe('Codex');
    expect(agent.agentName).toBe('reviewer');
    expect(broadcasts).toContainEqual({
      type: 'agentTeamInfo',
      id: agent.id,
      teamName: 'Codex',
      agentName: 'reviewer',
    });
  });
});

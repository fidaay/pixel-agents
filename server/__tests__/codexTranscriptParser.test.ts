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
        payload: { type: 'function_call', name: 'shell_command', call_id: 'call-1' },
      }),
      store,
      waitingTimers,
      permissionTimers,
    );

    expect(agent.activeToolIds.has('call-1')).toBe(true);
    expect(agent.activeToolStatuses.get('call-1')).toBe('Running command');
    expect(broadcasts).toContainEqual({ type: 'agentStatus', id: agent.id, status: 'active' });
    expect(broadcasts).toContainEqual({
      type: 'agentToolStart',
      id: agent.id,
      toolId: 'call-1',
      status: 'Running command',
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

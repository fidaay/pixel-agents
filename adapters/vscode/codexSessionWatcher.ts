import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentRuntime } from '../../server/src/agentRuntime.js';
import type { AgentStateStore } from '../../server/src/agentStateStore.js';
import {
  EXTERNAL_SCAN_INTERVAL_MS,
  GLOBAL_SCAN_ACTIVE_MAX_AGE_MS,
} from '../../server/src/constants.js';
import { readNewLines, startFileWatching } from '../../server/src/fileWatcher.js';
import type { AgentState } from '../../server/src/types.js';

interface CodexSessionMeta {
  id: string;
  cwd?: string;
  thread_source?: string;
  agent_nickname?: string;
  agent_role?: string;
}

interface CodexScanContext {
  runtime: AgentRuntime;
  store: AgentStateStore;
  workspaceFolders: string[];
}

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

function normalizePath(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

function isInsideWorkspace(cwd: string | undefined, workspaceFolders: string[]): boolean {
  if (!cwd) return false;

  const normalizedCwd = normalizePath(cwd);

  return workspaceFolders.some((workspaceFolder) => {
    const normalizedWorkspace = normalizePath(workspaceFolder);
    return (
      normalizedCwd === normalizedWorkspace ||
      normalizedCwd.startsWith(`${normalizedWorkspace}${path.sep}`)
    );
  });
}

function getCodexSessionFiles(root: string): string[] {
  const files: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > 4) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);

      if (entry.isDirectory()) {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
      } else if (entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function readSessionMeta(filePath: string): CodexSessionMeta | null {
  let fd: number | null = null;

  try {
    fd = fs.openSync(filePath, 'r');
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(4096);

    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;

      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      chunks.push(chunk);

      if (chunk.includes(10)) break;
      if (chunks.reduce((size, item) => size + item.length, 0) > 262_144) break;
    }

    const firstLine = Buffer.concat(chunks).toString('utf-8').split('\n')[0];
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: Partial<CodexSessionMeta>;
    };

    if (parsed.type !== 'session_meta' || !parsed.payload?.id) {
      return null;
    }

    return {
      id: parsed.payload.id,
      cwd: parsed.payload.cwd,
      thread_source: parsed.payload.thread_source,
      agent_nickname: parsed.payload.agent_nickname,
      agent_role: parsed.payload.agent_role,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function isTracked(filePath: string, store: AgentStateStore): boolean {
  const normalizedFile = normalizePath(filePath);

  for (const agent of store.values()) {
    if (normalizePath(agent.jsonlFile) === normalizedFile) {
      return true;
    }
  }

  return false;
}

function buildFolderName(meta: CodexSessionMeta): string {
  if (meta.agent_nickname && meta.agent_role) {
    return `${meta.agent_nickname} (${meta.agent_role})`;
  }

  if (meta.agent_nickname) return meta.agent_nickname;
  if (meta.agent_role) return meta.agent_role;
  if (meta.thread_source === 'subagent') return 'Codex subagent';

  return 'Codex';
}

function adoptCodexSession(
  filePath: string,
  meta: CodexSessionMeta,
  context: CodexScanContext,
): void {
  const { runtime, store } = context;
  const id = store.nextAgentId.current++;
  let fileOffset = 0;

  try {
    const stat = fs.statSync(filePath);
    fileOffset = stat.size;
  } catch {
    /* start from beginning if stat fails */
  }

  const agent: AgentState = {
    id,
    sessionId: meta.id,
    terminalRef: undefined,
    isExternal: true,
    projectDir: path.dirname(filePath),
    jsonlFile: filePath,
    fileOffset,
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
    lastDataAt: Date.now(),
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    providerId: 'codex',
    folderName: buildFolderName(meta),
    teamName: 'Codex',
    agentName: meta.agent_role,
    inputTokens: 0,
    outputTokens: 0,
  };

  runtime.knownJsonlFiles.add(filePath);
  store.set(id, agent);
  store.persist();

  startFileWatching(
    id,
    filePath,
    store,
    runtime.fileWatchers,
    runtime.pollingTimers,
    runtime.waitingTimers,
    runtime.permissionTimers,
  );
  readNewLines(id, store, runtime.waitingTimers, runtime.permissionTimers);

  console.log(
    `[Pixel Agents] Codex: detected session ${path.basename(filePath)} (${agent.folderName})`,
  );
}

function scanCodexSessions(context: CodexScanContext): void {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return;

  const now = Date.now();

  for (const filePath of getCodexSessionFiles(CODEX_SESSIONS_DIR)) {
    if (context.runtime.knownJsonlFiles.has(filePath)) continue;
    if (isTracked(filePath, context.store)) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }

    if (now - stat.mtimeMs > GLOBAL_SCAN_ACTIVE_MAX_AGE_MS) continue;

    const meta = readSessionMeta(filePath);
    if (!meta || !isInsideWorkspace(meta.cwd, context.workspaceFolders)) continue;

    adoptCodexSession(filePath, meta, context);
  }
}

export function startCodexSessionWatcher(
  context: CodexScanContext,
): ReturnType<typeof setInterval> {
  scanCodexSessions(context);

  return setInterval(() => {
    scanCodexSessions(context);
  }, EXTERNAL_SCAN_INTERVAL_MS);
}

import { redactSecretsForModel } from './modelSecretRedaction';

const MAX_DECISIONS = 15;
const MAX_BLOCKERS = 10;
/** Cap activeHosts to prevent unbounded growth; oldest entries are evicted. */
const MAX_ACTIVE_HOSTS = 100;
/** Cap terminalReadCursors to prevent unbounded growth; oldest entries are evicted. */
const MAX_TERMINAL_READ_CURSORS = 50;

export interface ActiveTerminalJobState {
  sessionId?: string;
  command?: string;
  status: string;
  nextOffset: number;
}

export interface TerminalReadCursorState {
  range: string;
  startLine?: number;
  endLine?: number;
}

export interface CattySessionState {
  version: 1;
  userGoal?: string;
  decisions: string[];
  activeHosts: Record<string, { hostname?: string; lastCommand?: string }>;
  activeJobs: Record<string, ActiveTerminalJobState>;
  terminalReadCursors: Record<string, TerminalReadCursorState>;
  editedFiles: string[];
  planItems: Array<{ text: string; completed: boolean }>;
  blockers: string[];
  updatedAt: number;
}

function emptyState(): CattySessionState {
  return {
    version: 1,
    decisions: [],
    activeHosts: {},
    activeJobs: {},
    terminalReadCursors: {},
    editedFiles: [],
    planItems: [],
    blockers: [],
    updatedAt: Date.now(),
  };
}

function pushUnique(list: string[], value: string, cap: number): string[] {
  const trimmed = value.trim();
  if (!trimmed || list.includes(trimmed)) return list;
  return [...list, trimmed].slice(-cap);
}

function upsertMostRecent<T>(record: Record<string, T>, key: string, value: T): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return { ...next, [key]: value };
}

function parseResultObject(resultText: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(resultText);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function terminalJobDefinitelyGone(result: Record<string, unknown> | undefined, resultText: string): boolean {
  const status = typeof result?.status === 'string' ? result.status.toLowerCase() : '';
  if (['completed', 'failed', 'stopped', 'exited', 'cancelled', 'canceled', 'not_found'].includes(status)) return true;
  const error = typeof result?.error === 'string' ? result.error : resultText;
  return /\b(?:job|task)\b.{0,40}\b(?:not found|does not exist|no longer exists|already (?:finished|completed|exited|stopped))\b/i.test(error)
    || /\b(?:unknown|no such)\s+(?:job|task)\b/i.test(error);
}

export class SessionStateStore {
  private readonly bySession = new Map<string, CattySessionState>();

  get(chatSessionId: string): CattySessionState {
    return this.bySession.get(chatSessionId) ?? emptyState();
  }

  clear(chatSessionId: string): void {
    this.bySession.delete(chatSessionId);
  }

  mergeFromUserGoal(chatSessionId: string, goal: string | undefined): void {
    if (!goal?.trim()) return;
    const state = { ...this.get(chatSessionId) };
    state.userGoal = goal.trim().slice(0, 500);
    state.updatedAt = Date.now();
    this.bySession.set(chatSessionId, state);
  }

  mergeFromAssistantContent(chatSessionId: string, content: string): void {
    const decisionPatterns = [
      /\bdecided to\b[:\s]+(.{10,200})/i,
      /\bwill use\b[:\s]+(.{10,200})/i,
      /\bconstraint[:\s]+(.{10,200})/i,
    ];
    let state = this.get(chatSessionId);
    for (const pattern of decisionPatterns) {
      const match = content.match(pattern);
      if (match?.[1]) {
        state = {
          ...state,
          decisions: pushUnique(state.decisions, match[1].trim(), MAX_DECISIONS),
          updatedAt: Date.now(),
        };
      }
    }
    this.bySession.set(chatSessionId, state);
  }

  mergeFileChanges(chatSessionId: string, paths: string[]): void {
    const state = { ...this.get(chatSessionId) };
    state.editedFiles = paths.reduce(
      (files, path) => pushUnique(files, path, 50),
      state.editedFiles,
    );
    state.updatedAt = Date.now();
    this.bySession.set(chatSessionId, state);
  }

  mergePlan(chatSessionId: string, items: Array<{ text: string; completed: boolean }>): void {
    const state = { ...this.get(chatSessionId) };
    state.planItems = items.slice(-30).map(item => ({
      text: item.text.slice(0, 300),
      completed: item.completed,
    }));
    state.updatedAt = Date.now();
    this.bySession.set(chatSessionId, state);
  }

  updateFromToolResult(
    chatSessionId: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    resultText: string,
    isError?: boolean,
  ): void {
    const state = { ...this.get(chatSessionId) };
    const name = toolName.toLowerCase();
    const result = parseResultObject(resultText);

    if (name === 'terminal_execute' || name === 'terminal.execute') {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
      const command = typeof args?.command === 'string' ? args.command : undefined;
      if (sessionId) {
        state.activeHosts = upsertMostRecent(state.activeHosts, sessionId, {
          ...state.activeHosts[sessionId],
          lastCommand: command,
        });
      }
    }

    if (name === 'terminal_start' || name === 'terminal.start') {
      const jobId = typeof result?.jobId === 'string' ? result.jobId : undefined;
      if (jobId && !isError) {
        state.activeJobs = upsertMostRecent(state.activeJobs, jobId, {
          sessionId: typeof args?.sessionId === 'string' ? args.sessionId : undefined,
          command: typeof args?.command === 'string' ? args.command : undefined,
          status: typeof result?.status === 'string' ? result.status : 'running',
          nextOffset: typeof result?.nextOffset === 'number' ? result.nextOffset : 0,
        });
      }
    }

    if (name === 'terminal_poll' || name === 'terminal.poll') {
      const jobId = typeof args?.jobId === 'string'
        ? args.jobId
        : typeof result?.jobId === 'string' ? result.jobId : undefined;
      if (jobId && !isError) {
        const status = typeof result?.status === 'string' ? result.status : 'running';
        if (status === 'running' || status === 'stopping') {
          state.activeJobs = upsertMostRecent(state.activeJobs, jobId, {
            ...state.activeJobs[jobId],
            status,
            nextOffset: typeof result?.nextOffset === 'number'
              ? result.nextOffset
              : state.activeJobs[jobId]?.nextOffset ?? 0,
          });
        } else if (state.activeJobs[jobId]) {
          state.activeJobs = { ...state.activeJobs };
          delete state.activeJobs[jobId];
        }
      } else if (jobId && state.activeJobs[jobId]) {
        if (terminalJobDefinitelyGone(result, resultText)) {
          state.activeJobs = { ...state.activeJobs };
          delete state.activeJobs[jobId];
        } else {
          state.activeJobs = upsertMostRecent(state.activeJobs, jobId, {
            ...state.activeJobs[jobId],
            status: 'unverified',
          });
        }
      }
    }

    if (name === 'terminal_stop' || name === 'terminal.stop') {
      const jobId = typeof args?.jobId === 'string' ? args.jobId : undefined;
      if (jobId && state.activeJobs[jobId]) {
        state.activeJobs = upsertMostRecent(state.activeJobs, jobId, {
          ...state.activeJobs[jobId],
          status: 'stopping',
        });
      }
    }

    if (name === 'terminal_read_context' || name === 'terminal.read_context') {
      const sessionId = typeof args?.sessionId === 'string'
        ? args.sessionId
        : typeof result?.sessionId === 'string' ? result.sessionId : undefined;
      if (sessionId && !isError) {
        state.terminalReadCursors = upsertMostRecent(state.terminalReadCursors, sessionId, {
          range: typeof args?.range === 'string' ? args.range : 'viewport',
          startLine: typeof result?.startLine === 'number'
            ? result.startLine
            : typeof args?.startLine === 'number' ? args.startLine : undefined,
          endLine: typeof result?.endLine === 'number' ? result.endLine : undefined,
        });
      }
    }

    if ((name === 'session_close' || name === 'session.close') && !isError) {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
      if (sessionId) {
        state.activeHosts = { ...state.activeHosts };
        state.terminalReadCursors = { ...state.terminalReadCursors };
        delete state.activeHosts[sessionId];
        delete state.terminalReadCursors[sessionId];
        state.activeJobs = Object.fromEntries(
          Object.entries(state.activeJobs).filter(([, job]) => job.sessionId !== sessionId),
        );
      }
    }

    if (isError) {
      const preview = resultText.slice(0, 160).replace(/\s+/g, ' ').trim();
      if (preview) {
        state.blockers = pushUnique(state.blockers, `${toolName}: ${preview}`, MAX_BLOCKERS);
      }
    }

    state.updatedAt = Date.now();
    this.bySession.set(chatSessionId, state);
    this.pruneActiveHosts(chatSessionId);
    this.pruneTerminalReadCursors(chatSessionId);
  }

  /**
   * Evict the oldest activeHosts entries when the record exceeds the cap.
   * Updates are moved to the end by upsertMostRecent(), so the first keys are
   * the least recently used entries.
   */
  private pruneActiveHosts(chatSessionId: string): void {
    const state = this.bySession.get(chatSessionId);
    if (!state) return;
    const keys = Object.keys(state.activeHosts);
    if (keys.length <= MAX_ACTIVE_HOSTS) return;
    const excess = keys.length - MAX_ACTIVE_HOSTS;
    console.debug('[SessionState] pruning activeHosts: exceeded cap, trimming oldest entries', { count: keys.length, cap: MAX_ACTIVE_HOSTS });
    const pruned = { ...state.activeHosts };
    for (let i = 0; i < excess; i++) {
      delete pruned[keys[i]];
    }
    state.activeHosts = pruned;
  }

  /**
   * Evict the least recently read terminal cursors. Active jobs are not capped:
   * every retained entry represents a command that may still be running and
   * must survive compaction to prevent accidental duplicate execution.
   */
  private pruneTerminalReadCursors(chatSessionId: string): void {
    const state = this.bySession.get(chatSessionId);
    if (!state) return;

    const cursorKeys = Object.keys(state.terminalReadCursors);
    if (cursorKeys.length > MAX_TERMINAL_READ_CURSORS) {
      console.debug('[SessionState] pruning terminalReadCursors: exceeded cap, trimming oldest entries', { count: cursorKeys.length, cap: MAX_TERMINAL_READ_CURSORS });
      const excess = cursorKeys.length - MAX_TERMINAL_READ_CURSORS;
      const pruned = { ...state.terminalReadCursors };
      for (let i = 0; i < excess; i++) {
        delete pruned[cursorKeys[i]];
      }
      state.terminalReadCursors = pruned;
    }
  }

  toReinjectionText(chatSessionId: string): string | undefined {
    const state = this.get(chatSessionId);
    const lines: string[] = [];
    if (state.userGoal) lines.push(`User goal: ${state.userGoal}`);
    if (state.decisions.length) {
      lines.push(`Decisions: ${state.decisions.slice(-5).join('; ')}`);
    }
    const hosts = Object.entries(state.activeHosts);
    if (hosts.length) {
      const hostSummary = hosts
        .slice(-5)
        .map(([id, host]) => `${id}${host.lastCommand ? ` (last: ${redactSecretsForModel(host.lastCommand)})` : ''}`)
        .join(', ');
      lines.push(`Active hosts: ${hostSummary}`);
    }
    const jobs = Object.entries(state.activeJobs);
    if (jobs.length) {
      const recentJobs = jobs.slice(-5);
      const olderJobs = jobs.slice(0, -5);
      const jobSummary = recentJobs.map(([jobId, job]) => (
        `${jobId} (status=${job.status}, offset=${job.nextOffset}${job.sessionId ? `, session=${job.sessionId}` : ''}${job.command ? `, command=${redactSecretsForModel(job.command)}` : ''})`
      )).join('; ');
      lines.push(`Remembered terminal jobs (status is unverified after compaction): ${jobSummary}. Poll the existing job from its saved offset to verify current status; do not restart its command.`);
      if (olderJobs.length) {
        const olderSummary = olderJobs.map(([jobId, job]) => (
          `${jobId} (status=${job.status}${job.sessionId ? `, session=${job.sessionId}` : ''})`
        )).join('; ');
        lines.push(`Additional remembered terminal jobs (do not restart): ${olderSummary}. Poll by job id before taking action.`);
      }
    }
    const cursors = Object.entries(state.terminalReadCursors);
    if (cursors.length) {
      lines.push(`Terminal read cursors: ${cursors.slice(-5).map(([id, cursor]) => `${id} (${cursor.range}, lines=${cursor.startLine ?? '?'}-${cursor.endLine ?? '?'})`).join(', ')}`);
    }
    if (state.editedFiles.length) {
      lines.push(`Edited files: ${state.editedFiles.slice(-20).join(', ')}`);
    }
    if (state.planItems.length) {
      lines.push(`Plan: ${state.planItems.map(item => `${item.completed ? '[done]' : '[todo]'} ${item.text}`).join('; ')}`);
    }
    if (state.blockers.length) {
      lines.push(`Open blockers: ${state.blockers.slice(-3).join('; ')}`);
    }
    if (lines.length === 0) return undefined;
    return lines.join('\n');
  }
}

export const globalSessionStateStore = new SessionStateStore();

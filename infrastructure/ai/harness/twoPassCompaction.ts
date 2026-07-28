import type { ModelMessage } from 'ai';
import { findSafeCompactionSplitIndex } from '../contextCompaction';

/** Entries older than this are considered stale and eligible for eviction.
 *  Set to 60 minutes to accommodate long coding sessions. */
const MAX_ENTRY_AGE_MS = 60 * 60 * 1000; // 60 minutes

interface CacheEntry {
  modelId: string;
  prefixLength: number;
  fingerprint: string;
  notePromise: Promise<string>;
  createdAt: number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function fingerprintMessages(messages: ModelMessage[]): string {
  const value = JSON.stringify(canonicalize(messages));
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export class TwoPassCompactionCache {
  private readonly entries = new Map<string, CacheEntry>();

  start(
    chatSessionId: string,
    modelId: string,
    messages: ModelMessage[],
    producer: (prefix: ModelMessage[]) => Promise<string>,
  ): boolean {
    const current = this.entries.get(chatSessionId);
    if (
      current
      && current.modelId === modelId
      && messages.length >= current.prefixLength
      && fingerprintMessages(messages.slice(0, current.prefixLength)) === current.fingerprint
    ) {
      return false;
    }
    const protectedTail = Math.max(10, Math.ceil(messages.length * 0.05));
    const prefixLength = findSafeCompactionSplitIndex(messages, protectedTail);
    if (prefixLength <= 0) return false;
    const prefix = messages.slice(0, prefixLength);
    const fingerprint = fingerprintMessages(prefix);
    if (
      current
      && current.modelId === modelId
      && current.prefixLength === prefixLength
      && current.fingerprint === fingerprint
    ) {
      return false;
    }
    this.entries.set(chatSessionId, {
      modelId,
      prefixLength,
      fingerprint,
      notePromise: producer(prefix).then(note => note.slice(0, 12_000)).catch(() => ''),
      createdAt: Date.now(),
    });
    this.pruneStale();
    return true;
  }

  async consume(
    chatSessionId: string,
    modelId: string,
    messages: ModelMessage[],
  ): Promise<{ note: string; prefixLength: number } | undefined> {
    const entry = this.entries.get(chatSessionId);
    if (!entry || entry.modelId !== modelId || messages.length < entry.prefixLength) {
      this.entries.delete(chatSessionId);
      return undefined;
    }
    const prefix = messages.slice(0, entry.prefixLength);
    if (fingerprintMessages(prefix) !== entry.fingerprint) {
      this.entries.delete(chatSessionId);
      return undefined;
    }
    // Refresh TTL on successful match so actively used entries are not pruned
    // during long sessions.
    entry.createdAt = Date.now();
    const note = await entry.notePromise;
    return note ? { note, prefixLength: entry.prefixLength } : undefined;
  }

  clear(chatSessionId: string): void {
    this.entries.delete(chatSessionId);
  }

  /**
   * Remove cache entries whose age exceeds MAX_ENTRY_AGE_MS.
   * Called during start() to prevent abandoned sessions from
   * accumulating stale entries with pending Promises.
   */
  private pruneStale(): void {
    const cutoff = Date.now() - MAX_ENTRY_AGE_MS;
    for (const [key, entry] of this.entries) {
      if (entry.createdAt < cutoff) {
        this.entries.delete(key);
      }
    }
  }
}

export const globalTwoPassCompactionCache = new TwoPassCompactionCache();

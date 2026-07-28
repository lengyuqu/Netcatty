import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalReconnectRegistry } from './terminalReconnectRegistry';

test('a registered terminal session can be reconnected on request', () => {
  const registry = createTerminalReconnectRegistry();
  const requestedSessionIds: string[] = [];

  registry.register('session-1', () => requestedSessionIds.push('session-1'));

  assert.equal(registry.request('session-1'), true);
  assert.deepEqual(requestedSessionIds, ['session-1']);
});

test('requesting a terminal session before its handler mounts reconnects after registration', () => {
  const registry = createTerminalReconnectRegistry();
  const requests: string[] = [];

  assert.equal(registry.request('session-1'), true);
  assert.deepEqual(requests, []);

  registry.register('session-1', () => requests.push('session-1'));

  assert.deepEqual(requests, ['session-1']);
});

test('cleanup only removes the handler that created it', () => {
  const registry = createTerminalReconnectRegistry();
  const requests: string[] = [];
  const unregisterOldHandler = registry.register('session-1', () => requests.push('old'));

  registry.register('session-1', () => requests.push('current'));
  unregisterOldHandler();

  assert.equal(registry.request('session-1'), true);
  assert.deepEqual(requests, ['current']);
});

test('a pending reconnect request expires even if no handler registers in time', () => {
  let expirePendingRequest: (() => void) | undefined;
  const registry = createTerminalReconnectRegistry({
    pendingRequestTtlMs: 10,
    setTimer(callback) {
      expirePendingRequest = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer() {},
  });
  const requests: string[] = [];

  registry.request('session-1');
  expirePendingRequest?.();
  registry.register('session-1', () => requests.push('session-1'));

  assert.deepEqual(requests, []);
});

test('registering a pending reconnect clears its expiry timer', () => {
  const clearedTimers: Array<ReturnType<typeof setTimeout>> = [];
  const timer = 1 as unknown as ReturnType<typeof setTimeout>;
  const registry = createTerminalReconnectRegistry({
    setTimer: () => timer,
    clearTimer: (pendingTimer) => clearedTimers.push(pendingTimer),
  });

  registry.request('session-1');
  registry.register('session-1', () => {});

  assert.deepEqual(clearedTimers, [timer]);
});

test('cleanup from a replaced handler does not clear a newer pending reconnect', () => {
  const registry = createTerminalReconnectRegistry();
  const requests: string[] = [];
  const unregisterOld = registry.register('session-1', () => requests.push('old'));
  const unregisterCurrent = registry.register('session-1', () => requests.push('current'));

  unregisterCurrent();
  registry.request('session-1');
  unregisterOld();
  registry.register('session-1', () => requests.push('replacement'));

  assert.deepEqual(requests, ['replacement']);
});

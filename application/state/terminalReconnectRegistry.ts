type TerminalReconnectHandler = () => void;

/** Pending requests expire after this duration if no handler registers. */
const PENDING_REQUEST_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface TerminalReconnectRegistryOptions {
  pendingRequestTtlMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export const createTerminalReconnectRegistry = (
  options: TerminalReconnectRegistryOptions = {},
) => {
  const handlers = new Map<string, TerminalReconnectHandler>();
  const pendingRequests = new Set<string>();
  const pendingRequestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingRequestTtlMs = options.pendingRequestTtlMs ?? PENDING_REQUEST_TTL_MS;
  const setTimer: NonNullable<TerminalReconnectRegistryOptions['setTimer']> =
    options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer: NonNullable<TerminalReconnectRegistryOptions['clearTimer']> =
    options.clearTimer ?? ((timer) => clearTimeout(timer));

  const clearPendingRequest = (sessionId: string): void => {
    pendingRequests.delete(sessionId);
    const timer = pendingRequestTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimer(timer);
      pendingRequestTimers.delete(sessionId);
    }
  };

  const register = (sessionId: string, handler: TerminalReconnectHandler): (() => void) => {
    handlers.set(sessionId, handler);
    if (pendingRequests.has(sessionId)) {
      clearPendingRequest(sessionId);
      handler();
    }
    return () => {
      if (handlers.get(sessionId) === handler) {
        handlers.delete(sessionId);
        clearPendingRequest(sessionId);
      }
    };
  };

  const request = (sessionId: string): boolean => {
    const handler = handlers.get(sessionId);
    if (!handler) {
      clearPendingRequest(sessionId);
      pendingRequests.add(sessionId);
      const timer = setTimer(() => {
        pendingRequests.delete(sessionId);
        pendingRequestTimers.delete(sessionId);
      }, pendingRequestTtlMs);
      (timer as { unref?: () => void }).unref?.();
      pendingRequestTimers.set(sessionId, timer);
      return true;
    }
    handler();
    return true;
  };

  return { register, request, clearPendingRequest };
};

export const terminalReconnectRegistry = createTerminalReconnectRegistry();

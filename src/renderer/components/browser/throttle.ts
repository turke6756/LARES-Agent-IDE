// Leading + trailing throttle for the BrowserViewHost bounds stream: the
// first call fires immediately (view glues to the host div without a visible
// lag), calls during the window collapse into one trailing invocation with the
// latest args (the final bounds after a resize burst are never dropped).

export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  /** Drop any pending trailing call (for unmount cleanup). */
  cancel(): void;
}

export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): Throttled<A> {
  let lastInvoke = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: A | null = null;

  const invoke = (args: A) => {
    lastInvoke = Date.now();
    fn(...args);
  };

  const throttled = (...args: A) => {
    const remaining = ms - (Date.now() - lastInvoke);
    if (remaining <= 0 && timer === null) {
      invoke(args);
      return;
    }
    pendingArgs = args;
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        if (pendingArgs !== null) {
          const args = pendingArgs;
          pendingArgs = null;
          invoke(args);
        }
      }, Math.max(remaining, 0));
    }
  };

  throttled.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pendingArgs = null;
  };

  return throttled;
}

// Best-effort reporting is independent of admission. Sinks must honor the signal
// and avoid synchronous CPU work. A host lifecycle hook keeps serverless work alive.
export function createReporter({onObservation = event => console.log(JSON.stringify(event)),
  waitUntil, reportingTimeoutMs = 1000, maxPendingReports = 100}) {
  if (typeof onObservation !== 'function' || (waitUntil !== undefined && typeof waitUntil !== 'function'))
    throw new Error('Invalid reporting hooks');
  for (const value of [reportingTimeoutMs, maxPendingReports])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid reporting bounds');
  if(reportingTimeoutMs>10000||maxPendingReports>10000)throw Error('Reporting bounds exceed maximum');
  const pending = new Set();
  return {
    send(event) {
      if (pending.size >= maxPendingReports) {
        console.warn('WebDecoy report dropped: queue full');
        return Promise.resolve();
      }
      const controller = new AbortController();
      let timer;
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
          controller.abort();
          console.warn('WebDecoy report timed out');
          resolve();
        }, reportingTimeoutMs);
      });
      const delivery = Promise.resolve().then(() => onObservation(event, {signal:controller.signal})).catch(() => {
        console.warn('WebDecoy report failed');
      });
      const task = Promise.race([delivery, timeout]).finally(() => {
        clearTimeout(timer);
        pending.delete(task);
      });
      pending.add(task);
      try {
        const scheduled = waitUntil?.(task);
        if (scheduled && typeof scheduled.then === 'function')
          Promise.resolve(scheduled).catch(() => console.warn('WebDecoy reporting lifecycle hook failed'));
      } catch { console.warn('WebDecoy reporting lifecycle hook failed'); }
      return task;
    },
    async flush() { await Promise.all([...pending]); }
  };
}

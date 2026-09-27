const code = /^[a-z][a-z0-9_]{0,63}$/;
export function prepareRules(rules = []) {
  if (!Array.isArray(rules) || rules.length > 32) throw new Error('rules must be an array of at most 32 rules');
  const ids = new Set(['webdecoy']);
  return rules.map(rule => {
    if (!rule || typeof rule.id !== 'string' || !code.test(rule.id) || ids.has(rule.id) || typeof rule.evaluate !== 'function')
      throw new Error('Local rules require unique stable IDs and evaluate functions');
    const mode = rule.mode ?? 'observe';
    const failureMode = rule.failureMode ?? 'closed';
    if (!['observe','enforce'].includes(mode) || !['open','closed'].includes(failureMode)) throw new Error('Invalid local rule mode');
    ids.add(rule.id);
    return {id:rule.id, mode, failureMode, evaluate:rule.evaluate};
  });
}

export function evaluateRules(rules, context, signal) {
  const checks = [];
  let denial;
  for (const rule of rules) {
    signal.throwIfAborted();
    const started = performance.now();
    let result;
    try {
      const value = rule.evaluate(context);
      // Local checks are synchronous and deterministic. Never leave a rejected
      // promise unhandled if an async rule is accidentally supplied.
      if (value && typeof value.then === 'function') {
        Promise.resolve(value).catch(() => {});
        throw new Error('Async local rule');
      }
      if (!value || typeof value.allowed !== 'boolean' ||
          (value.reason !== undefined && (typeof value.reason !== 'string' || !code.test(value.reason))) ||
          (value.status !== undefined && ![403,429].includes(value.status))) throw new Error('Invalid local rule result');
      result = {id:rule.id, source:'local', mode:rule.mode, decision:value.allowed ? 'allow' : 'deny',
        reason:value.reason ?? (value.allowed ? 'rule_allowed' : 'rule_denied')};
      if (!value.allowed && rule.mode === 'enforce') denial ??= {reason:result.reason,status:value.status ?? 403};
    } catch {
      result = {id:rule.id, source:'local', mode:rule.mode, decision:'unavailable', reason:'local_rule_error'};
      if (rule.mode === 'enforce' && rule.failureMode === 'closed') denial ??= {reason:'local_rule_error',status:503};
    }
    result.durationMs = Math.round((performance.now() - started) * 100) / 100;
    checks.push(result);
  }
  signal.throwIfAborted();
  return {checks, denial};
}

/**
 * Audit diff helper — builds matched old/new value pairs for an entity update.
 *
 * Services load the existing row before updating it, so the previous value of
 * every changed field is already in hand. Emitting only `newValues` (the patch
 * the caller sent) throws that away and makes the audit log unable to answer
 * "what was this before?" — which is the whole point of keeping one.
 *
 * Use at every mutation site that has a before-state:
 *
 *   const { oldValues, newValues } = diffValues(existing, data);
 *   this.bus.emit('entity:mutated', { ..., oldValues, newValues });
 */

/** Fields that are never interesting in an audit diff. */
const DEFAULT_IGNORED = ['version', 'updated_at', 'created_at'] as const;

export interface AuditDiff {
  oldValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
  /** True when the patch changed nothing (useful for callers that want to skip work). */
  unchanged: boolean;
}

/**
 * Compare a patch against the row it will be applied to.
 *
 * Only keys present in `patch` are considered, and only those whose value
 * actually differs are reported — so a form that re-submits every field
 * produces a diff of just what the user really changed.
 *
 * `undefined` values in the patch mean "not supplied" and are skipped.
 * Absent previous values are normalised to `null` so the JSON blob stored in
 * `audit_logs.old_values` never silently drops a key.
 */
export function diffValues(
  before: Record<string, unknown> | undefined | null,
  patch: Record<string, unknown> | undefined | null,
  ignore: readonly string[] = DEFAULT_IGNORED,
): AuditDiff {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  const skip = new Set(ignore);

  if (patch) {
    for (const [key, next] of Object.entries(patch)) {
      if (next === undefined || skip.has(key)) continue;
      const prev = before ? before[key] : undefined;
      if (prev === next) continue;
      oldValues[key] = prev === undefined ? null : prev;
      newValues[key] = next;
    }
  }

  return {
    oldValues,
    newValues,
    unchanged: Object.keys(newValues).length === 0,
  };
}

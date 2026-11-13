export function normalizeRunningHours(value: string): number | undefined {
  const text = value.replace(/\s+/g, ' ').trim().replace(/,/g, '').replace(/\s*hrs?$/i, '');
  if (!text || text === '-' || text === '—') return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Classifies the immediate Save evidence without treating a missing transient
 * toast/response capture as an application failure. Persistence is still
 * verified separately by the calling scenario after refresh.
 */
export function runningHoursSaveAccepted(input: {
  responseStatus?: number;
  feedback: string;
  dialogClosed: boolean;
}): boolean {
  const feedback = input.feedback.replace(/\s+/g, ' ').trim();
  if (input.responseStatus !== undefined && input.responseStatus >= 400) return false;
  if (/\b(?:error|failed|failure|unable|cannot)\b/i.test(feedback)) return false;
  return (input.responseStatus !== undefined && input.responseStatus >= 200 && input.responseStatus < 400)
    || Boolean(feedback)
    || input.dialogClosed;
}

/**
 * Parent Component inheritance carries the source MASTER's numeric change to
 * the child. Refuse to calculate unless the UI confirmed that exact rule.
 */
export function expectedInheritedRunningHours(input: {
  masterBefore: number;
  masterAfter: number;
  inheritedBefore: number;
  counterType: string;
  counterSource: string;
}): number | undefined {
  if (!/^inherited$/i.test(input.counterType.trim()) || !/parent component/i.test(input.counterSource.trim())) {
    return undefined;
  }
  return input.inheritedBefore + (input.masterAfter - input.masterBefore);
}

export function throwCombinedFailures(
  message: string,
  primaryFailure: { cause: unknown } | undefined,
  cleanupFailures: readonly unknown[],
): void {
  const failures = [
    ...(primaryFailure === undefined ? [] : [primaryFailure.cause]),
    ...cleanupFailures,
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer.");
  }

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  let firstFailure: unknown;

  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(values[index] as T, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstFailure = error;
        }
      }
    }
  });

  await Promise.all(workers);
  if (failed) {
    throw firstFailure;
  }
  return results;
}

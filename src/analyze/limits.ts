/** Largest file content the CLI reads for analysis, whatever `maxFileSizeKb` allows. */
export const MAX_ANALYSIS_BYTES = 256 * 1024;

/** Parallel file and Git reads while collecting analysis input. */
export const ANALYSIS_IO_CONCURRENCY = 4;

/** Shared quota for retained UTF-8 content, not a process heap or resident-memory limit. */
export interface AnalysisContentBudget {
  readonly maxTotalBytes: number;
  readonly remainingBytes: number;
  retain(content: string): boolean;
}

export interface AnalysisCollectionOptions {
  contentBudget?: AnalysisContentBudget;
}

export function createAnalysisContentBudget(maxTotalBytes: number): AnalysisContentBudget {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0) {
    throw new Error("The analysis content budget must be a non-negative safe integer.");
  }
  let remainingBytes = maxTotalBytes;
  return {
    maxTotalBytes,
    get remainingBytes() {
      return remainingBytes;
    },
    retain(content) {
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > remainingBytes) {
        return false;
      }
      remainingBytes -= bytes;
      return true;
    },
  };
}

export function analysisBudgetSkipReason(budget: AnalysisContentBudget): string {
  return `Content was not scanned because the aggregate analysis budget of ${budget.maxTotalBytes} bytes would be exceeded.`;
}

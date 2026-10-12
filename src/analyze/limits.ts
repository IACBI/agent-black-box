/** Largest file content the CLI reads for analysis, whatever `maxFileSizeKb` allows. */
export const MAX_ANALYSIS_BYTES = 256 * 1024;

/** Parallel file and Git reads while collecting analysis input. */
export const ANALYSIS_IO_CONCURRENCY = 4;

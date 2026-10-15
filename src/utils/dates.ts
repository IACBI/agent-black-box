/** Parses a strict `YYYY-MM-DD` calendar date to UTC midnight; `flag` names the CLI option in error messages. */
export function parseCalendarDateFlag(value: string, flag: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${flag} must be a date in YYYY-MM-DD format.`);
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${flag} must be a valid date in YYYY-MM-DD format.`);
  }
  return timestamp;
}

import type { SessionCatalogEntry } from "./sessionCatalog.js";

export interface SessionBrowserIO {
  ask(prompt: string): Promise<string>;
  write(text: string): void;
}

export async function browseSessionCatalog(
  entries: readonly SessionCatalogEntry[],
  pageSize: number,
  io: SessionBrowserIO,
  showReport: (entry: SessionCatalogEntry) => Promise<string>
): Promise<void> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new Error("Browser page size must be between 1 and 50.");
  }
  if (entries.length === 0) {
    io.write("No matching Agent Black Box sessions were found.\n");
    return;
  }

  let page = 0;
  const pageCount = Math.ceil(entries.length / pageSize);
  while (true) {
    const visible = entries.slice(page * pageSize, (page + 1) * pageSize);
    io.write(renderSessionBrowserPage(visible, page, pageCount, entries.length));
    const answer = (await io.ask("Select a number, n/p for pages, or q to quit: ")).trim().toLowerCase();
    if (answer === "q") {
      return;
    }
    if (answer === "n" && page < pageCount - 1) {
      page += 1;
      continue;
    }
    if (answer === "p" && page > 0) {
      page -= 1;
      continue;
    }
    if (/^[1-9]\d*$/.test(answer)) {
      const selected = visible[Number(answer) - 1];
      if (selected) {
        if (selected.state !== "complete") {
          io.write(`Session ${selected.id} is ${selected.state}: ${selected.warning ?? "no finalized report"}.\n`);
        } else {
          io.write(`${await showReport(selected)}\n`);
        }
        continue;
      }
    }
    io.write("No such selection on this page.\n");
  }
}

export function renderSessionBrowserPage(
  entries: readonly SessionCatalogEntry[],
  page: number,
  pageCount: number,
  total: number
): string {
  const lines = [`Agent Black Box Sessions — page ${page + 1}/${pageCount} (${total} matches)`];
  entries.forEach((entry, index) => {
    const summary =
      entry.state === "complete"
        ? `${entry.startedAt ?? "unknown time"} | risk ${entry.riskScore ?? 0}/100 (${entry.maxRiskSeverity ?? "none"})`
        : (entry.warning ?? entry.startedAt ?? "no finalized report");
    lines.push(`${index + 1}. ${entry.id} [${entry.state}] | ${summary}`);
  });
  return `${lines.join("\n")}\n`;
}

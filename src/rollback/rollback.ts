import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { simpleGit } from "simple-git";
import type { ChangedFile, SessionReport } from "../types.js";
import { shellQuotePath } from "../utils/paths.js";

export interface RollbackPlan {
  requestedFiles: string[];
  restorableFiles: ChangedFile[];
  skippedFiles: Array<{ path: string; reason: string }>;
}

const RESTORABLE_STATUSES = new Set(["modified", "deleted"]);

export function createRollbackPlan(report: SessionReport, requestedFiles: string[] = []): RollbackPlan {
  const requested = new Set(requestedFiles);
  const candidateFiles =
    requestedFiles.length > 0
      ? report.git.changedFiles.filter((file) => requested.has(file.path))
      : report.git.changedFiles;
  const missingFiles = requestedFiles.filter((file) => !report.git.changedFiles.some((changed) => changed.path === file));
  const restorableFiles = candidateFiles.filter((file) => RESTORABLE_STATUSES.has(file.status));
  const skippedFiles = [
    ...candidateFiles
      .filter((file) => !RESTORABLE_STATUSES.has(file.status))
      .map((file) => ({
        path: file.path,
        reason: file.status === "added" ? "Added or untracked files are not removed automatically." : `Status ${file.status} is not automatically restored.`
      })),
    ...missingFiles.map((file) => ({
      path: file,
      reason: "File was not present in the latest Agent Black Box session report."
    }))
  ];

  return {
    requestedFiles,
    restorableFiles,
    skippedFiles
  };
}

export function renderRollbackPlan(plan: RollbackPlan): string {
  const lines = ["Agent Black Box Rollback Apply Plan", ""];

  if (plan.restorableFiles.length > 0) {
    lines.push("Files that can be restored after confirmation:");
    for (const file of plan.restorableFiles) {
      lines.push(`- ${file.status}: ${file.path}`);
    }
    lines.push("");
    lines.push("Command preview:");
    lines.push("```sh");
    lines.push(`git restore --source=HEAD --staged --worktree -- ${plan.restorableFiles.map((file) => shellQuotePath(file.path)).join(" ")}`);
    lines.push("```");
  } else {
    lines.push("No files are eligible for automatic restore.");
  }

  if (plan.skippedFiles.length > 0) {
    lines.push("");
    lines.push("Skipped files:");
    for (const file of plan.skippedFiles) {
      lines.push(`- ${file.path}: ${file.reason}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function confirmRollback(plan: RollbackPlan): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive rollback requires a TTY. Re-run the command in an interactive terminal.");
  }

  const confirmationText = getConfirmationText(plan);
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Type "${confirmationText}" to restore eligible files: `);
    return answer === confirmationText;
  } finally {
    rl.close();
  }
}

export async function applyRollbackPlan(repoRoot: string, plan: RollbackPlan): Promise<void> {
  if (plan.restorableFiles.length === 0) {
    return;
  }

  const git = simpleGit({ baseDir: repoRoot, binary: "git" });
  await git.raw(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...plan.restorableFiles.map((file) => file.path)]);
}

export function getConfirmationText(plan: RollbackPlan): string {
  const fileLabel = plan.restorableFiles.length === 1 ? "file" : "files";
  return `RESTORE ${plan.restorableFiles.length} ${fileLabel}`;
}

import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/config.js";
import { renderDoctorReport, runDoctor } from "../src/doctor/doctor.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

describe("doctor", () => {
  it("fails outside a Git repository", async () => {
    const dir = await createTempDir();
    try {
      const report = await runDoctor(dir);

      expect(report.ok).toBe(false);
      expect(renderDoctorReport(report)).toContain("FAIL Git repository");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("checks a configured Git repository", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      await createDefaultConfig(dir);

      const report = await runDoctor(dir);
      const rendered = renderDoctorReport(report);

      expect(report.ok).toBe(true);
      expect(rendered).toContain("PASS Node.js");
      expect(rendered).toContain("PASS Config");
      expect(rendered).toContain("PASS Session state");
    } finally {
      await removeTempDir(dir);
    }
  });
});

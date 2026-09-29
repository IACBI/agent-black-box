import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWindowsExecutable } from "../src/utils/executables.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

describe("Windows executable resolution", () => {
  it("resolves bare names through absolute PATH entries in PATHEXT order", async () => {
    const dir = await createTempDir();
    try {
      const first = path.join(dir, "first");
      const second = path.join(dir, "second");
      await mkdir(first);
      await mkdir(second);
      await writeFile(path.join(first, "task.bat"), "");
      await writeFile(path.join(first, "task.cmd"), "");
      await writeFile(path.join(second, "batonly.bat"), "");
      await writeFile(path.join(second, "tool.exe"), "");
      const searchPath = [first, second].join(path.delimiter);

      expect(resolveWindowsExecutable("task", dir, { PATH: searchPath, PATHEXT: ".COM;.EXE;.BAT;.CMD" })).toBe(
        path.join(first, "task.bat")
      );
      expect(resolveWindowsExecutable("task", dir, { PATH: searchPath, PATHEXT: ".CMD;.BAT" })).toBe(
        path.join(first, "task.cmd")
      );
      expect(resolveWindowsExecutable("batonly", dir, { PATH: searchPath })).toBe(path.join(second, "batonly.bat"));
      expect(resolveWindowsExecutable("tool", dir, { PATH: searchPath })).toBe(path.join(second, "tool.exe"));
      expect(resolveWindowsExecutable("missing", dir, { PATH: searchPath })).toBeNull();
    } finally {
      await removeTempDir(dir);
    }
  });

  it("uses an explicit extension as given and ignores extensions that cannot be spawned", async () => {
    const dir = await createTempDir();
    try {
      await writeFile(path.join(dir, "tool.exe"), "");
      await writeFile(path.join(dir, "script.vbs"), "");
      await writeFile(path.join(dir, "plain.cmd"), "");

      expect(resolveWindowsExecutable("tool.exe", dir, { PATH: dir })).toBe(path.join(dir, "tool.exe"));
      expect(resolveWindowsExecutable("tool.cmd", dir, { PATH: dir })).toBeNull();
      expect(resolveWindowsExecutable("script", dir, { PATH: dir, PATHEXT: ".VBS;.JS" })).toBeNull();
      expect(resolveWindowsExecutable("plain", dir, { PATH: dir, PATHEXT: ".EXE;.VBS" })).toBeNull();
    } finally {
      await removeTempDir(dir);
    }
  });

  it("skips directories that share an executable's name", async () => {
    const dir = await createTempDir();
    try {
      const shadowed = path.join(dir, "shadowed");
      const real = path.join(dir, "real");
      await mkdir(path.join(shadowed, "tool.exe"), { recursive: true });
      await mkdir(real);
      await writeFile(path.join(real, "tool.exe"), "");

      expect(resolveWindowsExecutable("tool", dir, { PATH: [shadowed, real].join(path.delimiter) })).toBe(
        path.join(real, "tool.exe")
      );
    } finally {
      await removeTempDir(dir);
    }
  });

  it("never resolves from the current directory or relative PATH entries", async () => {
    const dir = await createTempDir();
    try {
      await writeFile(path.join(dir, "shadow.cmd"), "");
      await writeFile(path.join(dir, "shadow.exe"), "");

      expect(resolveWindowsExecutable("shadow", dir, { PATH: ["", ".", "relative"].join(path.delimiter) })).toBeNull();
      expect(resolveWindowsExecutable("shadow", dir, { PATH: undefined })).toBeNull();
    } finally {
      await removeTempDir(dir);
    }
  });

  it("resolves names with a directory part against the working directory", async () => {
    const dir = await createTempDir();
    try {
      await mkdir(path.join(dir, "scripts"));
      await writeFile(path.join(dir, "scripts", "build.bat"), "");

      expect(resolveWindowsExecutable(path.join("scripts", "build"), dir, {})).toBe(
        path.join(dir, "scripts", "build.bat")
      );
      expect(resolveWindowsExecutable(path.join("scripts", "absent"), dir, {})).toBeNull();
    } finally {
      await removeTempDir(dir);
    }
  });
});

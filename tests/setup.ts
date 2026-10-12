import { inject } from "vitest";

// Tests must not depend on the developer's Git identity, hooks, aliases or terminal prompts, and a Git hook
// that launches the suite exports repository variables that would redirect every temp repository.
process.env.GIT_CONFIG_GLOBAL = inject("abbGitConfigGlobal");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";

for (const name of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
]) {
  delete process.env[name];
}

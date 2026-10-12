import path from "node:path";
import { describe, expect, it } from "vitest";
import { redactCommandParts } from "../src/commands/commandRecorder.js";
import { compileSecretRules } from "../src/risks/secretRules.js";

const secret = ["s3cr", "3t-va", "lue"].join("");
const curlExecutablePath = path.join(path.parse(process.cwd()).root, "tools", "curl.exe");

describe("short credential flags of well-known tools", () => {
  it.each([
    [
      ["curl", "-u", `admin:${secret}`, "https://example.test"],
      ["curl", "-u", "<redacted>", "https://example.test"],
    ],
    [
      ["curl", `-uadmin:${secret}`, "https://example.test"],
      ["curl", "-u<redacted>", "https://example.test"],
    ],
    [
      ["curl", `-Uproxy:${secret}`, "https://example.test"],
      ["curl", "-U<redacted>", "https://example.test"],
    ],
    [
      ["curl", "--user", `admin:${secret}`, "https://example.test"],
      ["curl", "--user", "<redacted>", "https://example.test"],
    ],
    [
      ["curl", `--user=admin:${secret}`, "https://example.test"],
      ["curl", "--user=<redacted>", "https://example.test"],
    ],
    [
      ["curl", "--proxy-user", `p:${secret}`],
      ["curl", "--proxy-user", "<redacted>"],
    ],
    [
      ["mysql", `-p${secret}`, "-h", "db"],
      ["mysql", "-p<redacted>", "-h", "db"],
    ],
    [
      ["mysqldump", "-u", "root", `-p${secret}`, "app"],
      ["mysqldump", "-u", "root", "-p<redacted>", "app"],
    ],
    [
      ["redis-cli", "-a", secret, "ping"],
      ["redis-cli", "-a", "<redacted>", "ping"],
    ],
    [
      ["sshpass", "-p", secret, "ssh", "host"],
      ["sshpass", "-p", "<redacted>", "ssh", "host"],
    ],
    [
      ["docker", "login", "-u", "me", "-p", secret],
      ["docker", "login", "-u", "me", "-p", "<redacted>"],
    ],
    [
      ["podman", "login", "-p", secret, "registry.test"],
      ["podman", "login", "-p", "<redacted>", "registry.test"],
    ],
    [
      [curlExecutablePath, "-u", `a:${secret}`],
      [curlExecutablePath, "-u", "<redacted>"],
    ],
  ])("redacts the credential in %j", (parts, expected) => {
    const redacted = redactCommandParts(parts);

    expect(redacted).toEqual(expected);
    expect(redacted.join(" ")).not.toContain(secret);
  });

  it.each([
    [["mysql", "-p", "-h", "db"]],
    [["mysql", "-P", "3306", "-h", "db"]],
    [["docker", "run", "-p", "8080:80", "nginx"]],
    [["docker", "ps", "-a"]],
    [["redis-cli", "-n", "2", "ping"]],
    [["curl", "-s", "-o", "out.txt", "https://example.test"]],
    [["curl", "-ooutput.txt", "-HAccept:application/json", "https://example.test"]],
    [["grep", "-u", "-p", "pattern"]],
    [["grep", "-uattached-pattern", "src"]],
  ])("leaves harmless flags of %j untouched", (parts) => {
    expect(redactCommandParts(parts)).toEqual(parts);
  });

  it("does not apply a tool's flag rules to other programs", () => {
    expect(redactCommandParts(["rsync", "-a", "src", "dst"])).toEqual(["rsync", "-a", "src", "dst"]);
    expect(redactCommandParts(["curl", "https://example.test", "-u"])).toEqual(["curl", "https://example.test", "-u"]);
  });
});

describe("credentials embedded in script arguments", () => {
  it.each([
    [`export TOKEN=${secret} && run`, "export TOKEN=<redacted> && run"],
    // A leading KEY=value is caught by the assignment rule, which hides the whole argument.
    [`API_KEY="${secret} with space" ./deploy.sh`, "API_KEY=<redacted>"],
    [`DB_PASSWORD='${secret}'; node app.js`, "DB_PASSWORD=<redacted>"],
    [
      `curl -H "Authorization: Bearer ${secret}" https://example.test`,
      'curl -H "Authorization: <redacted>" https://example.test',
    ],
    [`./login --password ${secret} --user me`, "./login --password <redacted> --user me"],
    [`./login --password "${secret} with space" --user me`, "./login --password <redacted> --user me"],
    [`./login --password '${secret} with space' --user me`, "./login --password <redacted> --user me"],
    [`./login --password "${secret}\nsecond line" --user me`, "./login --password <redacted> --user me"],
    [`./login --api_key "${secret} with space" --user me`, "./login --api_key <redacted> --user me"],
    [`./login --client_secret '${secret} with space' --user me`, "./login --client_secret <redacted> --user me"],
    [`./login --client-secret=${secret}`, "./login --client-secret=<redacted>"],
    [`./login --client-secret="${secret} with space" --user me`, "./login --client-secret=<redacted> --user me"],
    [`./login --client-secret='${secret} with space' --user me`, "./login --client-secret=<redacted> --user me"],
  ])("redacts the secret inside %j", (script, expected) => {
    const [, , redacted] = redactCommandParts(["sh", "-c", script]);

    expect(redacted).toBe(expected);
    expect(redacted).not.toContain(secret);
  });

  it.each([
    "echo hello world",
    "npm test -- --grep 'foo bar'",
    './search --query "foo bar" --mode="exact match"',
    './search --output_dir "ordinary path"',
    "git commit -m 'update token handling: done'",
    "make build TARGET=release",
    "for f in *.ts; do wc -l $f; done",
  ])("leaves an ordinary script alone: %s", (script) => {
    expect(redactCommandParts(["sh", "-c", script])).toEqual(["sh", "-c", script]);
  });
});

describe("provider token shapes and configured patterns", () => {
  it("redacts bare provider tokens that have no variable name or flag", () => {
    const github = `ghp_${"a1".repeat(12)}`;
    const aws = `AKIA${"Q".repeat(16)}`;
    const jwt = `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`;
    const redacted = redactCommandParts(["echo", github, `--data=${aws}`, jwt, "src/index.ts"]);

    expect(redacted).toEqual(["echo", "<redacted>", "--data=<redacted>", "<redacted>", "src/index.ts"]);
  });

  it("redacts a token split by the length limit instead of leaving a prefix of it", () => {
    const token = `ghp_${"a1".repeat(20)}`;
    const padding = "x".repeat(4070);
    const [redacted] = redactCommandParts([`${padding}${token}-${"y".repeat(100)}`]);

    expect(redacted).not.toContain("ghp_");
    expect(redacted).toContain("<redacted>");
    expect(redacted).toMatch(/…<truncated>$/);
  });

  it("applies the repository's own patterns to arguments and leaves other arguments alone", () => {
    const rules = compileSecretRules({
      secretPatterns: [{ name: "Internal service token", pattern: "corp_[a-z0-9]{16}" }],
    });
    const value = "corp_0123456789abcdef";

    expect(redactCommandParts(["deploy", value, `--note=uses ${value} twice ${value}`, "src"], rules)).toEqual([
      "deploy",
      "<redacted>",
      "--note=uses <redacted> twice <redacted>",
      "src",
    ]);
    expect(redactCommandParts(["deploy", value])).toEqual(["deploy", value]);
  });

  it("keeps redacting URL credentials in any scheme while leaving harmless URLs intact", () => {
    const redacted = redactCommandParts([
      `postgres://app:${secret}@db.example.test/main`,
      "https://example.test/path?mode=safe",
      "ssh://git@example.test/repo.git",
    ]);

    expect(redacted[0]).not.toContain(secret);
    expect(redacted[0]).toContain("@db.example.test/main");
    expect(redacted[1]).toBe("https://example.test/path?mode=safe");
    expect(redacted[2]).toBe("ssh://git@example.test/repo.git");
  });
});

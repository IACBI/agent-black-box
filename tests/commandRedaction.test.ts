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
      ["curl", "--oauth2-bearer", secret, "https://example.test"],
      ["curl", "--oauth2-bearer", "<redacted>", "https://example.test"],
    ],
    [
      ["curl", `--oauth2-bearer=${secret}`, "https://example.test"],
      ["curl", "--oauth2-bearer=<redacted>", "https://example.test"],
    ],
    [
      ["curl", "--pass", secret, "https://example.test"],
      ["curl", "--pass", "<redacted>", "https://example.test"],
    ],
    [
      ["curl", `--pass=${secret}`, "https://example.test"],
      ["curl", "--pass=<redacted>", "https://example.test"],
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
      ["redis-cli", "--pass", secret, "ping"],
      ["redis-cli", "--pass", "<redacted>", "ping"],
    ],
    [
      ["redis-cli", `--pass=${secret}`, "ping"],
      ["redis-cli", "--pass=<redacted>", "ping"],
    ],
    [
      ["env", "MODE=safe", "redis-cli", "--pass", secret, "ping"],
      ["env", "MODE=safe", "redis-cli", "--pass", "<redacted>", "ping"],
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
    [["echo", "--pass", "ordinary text", "--oauth2-bearer=ordinary text"]],
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

describe("explicit env command wrappers", () => {
  it.each(
    [
      ["env", "MODE=safe", "curl", "-u", `admin:${secret}`],
      ["env", "-i", "API_TOKEN=" + secret, "curl", "--oauth2-bearer", secret],
      ["env", "--ignore-environment", "--debug", "curl", `--pass=${secret}`],
      ["env", "-u", "EDITOR", "-C", "workspace", "-a", "alias", "curl", "-u", secret],
      ["env", "--unset=EDITOR", "--chdir=workspace", "--argv0=alias", "curl", `-u${secret}`],
      ["env", "--unset", "EDITOR", "--chdir", "workspace", "--argv0", "alias", "curl", "--pass", secret],
      ["env", "-iuEDITOR", "-Cworkspace", "-aalias", "curl", "--pass", secret],
      ["env", "--", "MODE=safe", "curl", "-u", secret],
      ["env", "-", "MODE=safe", "curl", "-u", secret],
      ["env", "MODE=safe", "env", "-i", "curl", "-u", secret],
      ["env", "curl=ignored", "curl", "-u", secret],
      ["env", curlExecutablePath, "--oauth2-bearer", secret],
      [path.join(path.parse(process.cwd()).root, "tools", "env.exe"), "curl", "--pass", secret],
      ["env", "MODE=safe", "mysql", `-p${secret}`],
      ["env", "MODE=safe", "docker", "login", "-p", secret],
    ].map((parts) => [parts])
  )("redacts child credentials in %j without modifying executed argv", (parts) => {
    const original = [...parts];
    const redacted = redactCommandParts(parts);

    expect(parts).toEqual(original);
    expect(redacted.join(" ")).not.toContain(secret);
    expect(redacted).toContainEqual(expect.stringContaining("<redacted>"));
    expect(redacted[0]).toBe(parts[0]);
  });

  it("keeps env option operands distinct from the child credentials", () => {
    expect(redactCommandParts(["env", "-u", "curl", "-a", "curl", "curl", "-u", secret])).toEqual([
      "env",
      "-u",
      "curl",
      "-a",
      "curl",
      "curl",
      "-u",
      "<redacted>",
    ]);
  });

  it.each(
    [
      ["env", "echo", "curl", "-u", "ordinary"],
      ["env", "-u", "curl", "echo", "-u", "ordinary"],
      ["env", "-a", "curl", "echo", "-u", "ordinary"],
      ["env", "--", "echo", "-u", "ordinary"],
      ["env", "MODE=safe", "--", "curl", "-u", "ordinary"],
      ["env", "-", "-", "curl", "-u", "ordinary"],
      ["env", "MODE=safe"],
      ["env"],
      ["echo", "env", "curl", "-u", "ordinary"],
      ["env", "docker", "run", "-p", "8080:80", "nginx"],
    ].map((parts) => [parts])
  )("preserves ordinary arguments and command boundaries in %j", (parts) => {
    expect(redactCommandParts(parts)).toEqual(parts);
  });

  it.each(
    [
      ["env", "-S", `curl -u admin:${secret}`],
      ["env", `--split-string=curl -u admin:${secret}`],
      ["env", `-vScurl -u admin:${secret}`],
      ["env", "--unknown", "curl", "-u", secret],
      ["env", "--ch", "workspace", "curl", "-u", secret],
      ["env", "-u"],
      ["env", "--chdir"],
      ["env", "--chdir", "x".repeat(5000), "curl", "-u", secret],
      ["env", "MODE=safe", "env", "-S", `curl -u admin:${secret}`],
    ].map((parts) => [parts])
  )("hides ambiguous supported wrapper arguments in %j", (parts) => {
    expect(redactCommandParts(parts)).toEqual(parts.map((part, index) => (index === 0 ? part : "<redacted>")));
  });

  it("bounds nested wrappers and prefix scans while preserving supported finite prefixes", () => {
    const supported = [...Array<string>(8).fill("env"), "curl", "-u", secret];
    expect(redactCommandParts(supported).at(-1)).toBe("<redacted>");
    expect(redactCommandParts(supported).slice(0, 8)).toEqual(supported.slice(0, 8));
    for (const parts of [
      [...Array<string>(9).fill("env"), "curl", "-u", secret],
      ["env", ...Array<string>(128).fill("MODE=safe"), "curl", "-u", secret],
    ]) {
      expect(
        redactCommandParts(parts)
          .slice(1)
          .every((part) => part === "<redacted>")
      ).toBe(true);
    }
  });
});

describe("credentials embedded in script arguments", () => {
  it.each(["'", '"'])("redacts long quoted credentials before truncating script arguments (%s)", (quote) => {
    const credential = "synthetic-private-value-".repeat(250);
    const scripts = [
      `./login --password ${quote}${credential}${quote} --user me`,
      `export PASSWORD=${quote}${credential}${quote}; ./login`,
    ];

    for (const script of scripts) {
      const redacted = redactCommandParts(["sh", "-c", script]);

      expect(redacted[2]).toContain("<redacted>");
      expect(redacted[2]).not.toContain("synthetic-private-value-");
    }
  });

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

describe("sensitive JSON argument keys", () => {
  it.each([
    String.raw`{"pass\u0077ord":"synthetic-private-value"}`,
    String.raw`{"client\u005fsecret":"synthetic-private-value"}`,
    String.raw`{"nested":{"api\u005fkey":"synthetic-private-value"}}`,
  ])("redacts credentials when sensitive JSON keys contain escapes: %s", (json) => {
    expect(redactCommandParts(["curl", "--data", json])).toEqual(["curl", "--data", "<redacted>"]);
    expect(redactCommandParts(["curl", `--data=${json}`])).toEqual(["curl", "--data=<redacted>"]);
  });

  it("preserves escaped harmless keys and malformed JSON keys", () => {
    const json = String.raw`{"m\u006fde":"safe"}`;
    const malformed = String.raw`{"pass\x77ord":"ordinary text"}`;

    expect(redactCommandParts(["echo", json, malformed])).toEqual(["echo", json, malformed]);
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

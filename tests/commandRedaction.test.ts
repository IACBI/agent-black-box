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

describe("bounded command wrapper chains", () => {
  it.each([
    [["sudo", "-n", "-u", "curl", "curl", "-u", secret]],
    [["sudo", "--user=root", "--group", "staff", "MODE=safe", "curl", "--pass", secret]],
    [["sudo", "-Euuser", "--", "curl", `-u${secret}`]],
    [["sudo", "--preserve-env=MODE", "--non-interactive", "--chdir=workspace", "curl", "--pass", secret]],
    [["nohup", "curl", "-u", secret]],
    [["nice", "-n", "-5", "curl", "--pass", secret]],
    [["nice", "--adjustment=5", "curl", "-u", secret]],
    [["timeout", "-vk2s", "--signal", "TERM", "10s", "curl", "--pass", secret]],
    [["timeout", "--foreground", "--preserve-status", "--kill-after=2", "--", "1.5m", "curl", `-u${secret}`]],
    [["env", "MODE=safe", "sudo", "-n", "nohup", "nice", "-n5", "timeout", "10", "curl", "-u", secret]],
  ])("redacts child credentials through %j without changing execution argv", (parts) => {
    const original = [...parts];
    const redacted = redactCommandParts(parts);
    expect(parts).toEqual(original);
    expect(redacted.join(" ")).not.toContain(secret);
    expect(redacted.at(-1)).toContain("<redacted>");
    expect(redacted.slice(0, -1)).toEqual(parts.slice(0, -1));
  });

  it.each([
    [["sudo", "-u", "curl", "echo", "-u", "ordinary"]],
    [["nohup", "--", "echo", "curl", "-u", "ordinary"]],
    [["nice", "-n", "5", "echo", "-u", "ordinary"]],
    [["timeout", "-s", "curl", "1", "echo", "-u", "ordinary"]],
  ])("preserves wrapper operands and ordinary child arguments in %j", (parts) => {
    expect(redactCommandParts(parts)).toEqual(parts);
  });

  it.each([
    [["sudo", "-s", "curl", "-u", secret]],
    [["sudo", "--login", `curl -u ${secret}`]],
    [["sudo", "--unknown", "curl", "-u", secret]],
    [["sudo", "-u"]],
    [["nice", "--unknown", "curl", "-u", secret]],
    [["timeout", "--kill-after"]],
    [["timeout", "not-a-duration", "curl", "-u", secret]],
    [["sudo", "--background=unexpected", "curl", "-u", secret]],
    [["nohup", "curl".repeat(2000), "-u", secret]],
    [["nohup", "--unknown", "curl", "-u", secret]],
    [[...Array<string>(9).fill("nohup"), "curl", "-u", secret]],
  ])("hides ambiguous wrapper syntax in %j", (parts) => {
    expect(redactCommandParts(parts)).toEqual(parts.map((part, index) => (index === 0 ? part : "<redacted>")));
  });
});

describe("container login command boundaries", () => {
  it.each([
    [["docker", "--config", "login", "run", "-p", "8080:80", "login"]],
    [["docker", "-D", "--context=login", "run", "-p8080:80", "login"]],
    [["podman", "--connection", "login", "run", "-p", "8080:80", "login"]],
    [["env", "docker", "run", "-p", "8080:80", "login"]],
  ])("preserves port flags when login is an operand in %j", (parts) => {
    expect(redactCommandParts(parts)).toEqual(parts);
  });

  it.each([
    [["docker", "-H", "tcp://host:2375", "--config=login", "login", `-p${secret}`]],
    [["docker", "-D", "--tls=false", "--context", "login", "login", `-p=${secret}`]],
    [["podman", "-r", "--connection=remote", "login", "-p", secret]],
    [["sudo", "docker", "--", "login", "-p", secret]],
  ])("redacts credentials only after the login subcommand in %j", (parts) => {
    expect(redactCommandParts(parts).at(-1)).toContain("<redacted>");
    expect(redactCommandParts(parts).join(" ")).not.toContain(secret);
  });

  it("hides unknown global-option syntax conservatively", () => {
    const parts = ["docker", "--unknown", "value", "login", "-p", secret];
    expect(redactCommandParts(parts)).toEqual(["docker", ...Array<string>(5).fill("<redacted>")]);
  });

  it.each([
    [["docker", "--context"]],
    [["docker", "--tls=unexpected", "login", "-p", secret]],
    [["docker", "-X", "login", "-p", secret]],
  ])("hides malformed or ambiguous container prefixes in %j", (parts) => {
    expect(redactCommandParts(parts)).toEqual(parts.map((part, index) => (index === 0 ? part : "<redacted>")));
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

  it("does not retain credential suffixes when configured command patterns overlap", () => {
    const rules = compileSecretRules({
      secretPatterns: [
        { name: "Prefix", pattern: "corp_" },
        { name: "Complete token", pattern: "corp_[a-z0-9]{16}" },
      ],
    });
    const parts = ["deploy", "corp_0123456789abcdef", "--mode=safe"];
    expect(redactCommandParts(parts, rules)).toEqual(["deploy", "<redacted>", "--mode=safe"]);
    expect(parts).toEqual(["deploy", "corp_0123456789abcdef", "--mode=safe"]);
  });

  it("composes built-in and custom matches on the original argument without changing argv", () => {
    const providerToken = "ghp_" + "a1".repeat(12);
    const value = "corp_" + providerToken + "!private-suffix";
    const rules = compileSecretRules({
      secretPatterns: [{ name: "Whole internal token", pattern: "corp_ghp_[a-z0-9]{24}!private-suffix" }],
    });
    const parts = ["echo", value, "safe"];
    expect(redactCommandParts(parts, rules)).toEqual(["echo", "<redacted>", "safe"]);
    expect(parts).toEqual(["echo", value, "safe"]);
    const prefixRules = compileSecretRules({ secretPatterns: [{ name: "Provider prefix", pattern: "ghp_" }] });
    expect(redactCommandParts(["echo", providerToken], prefixRules)).toEqual(["echo", "<redacted>"]);
  });

  it("preserves custom script context while composing embedded credential masking", () => {
    const providerToken = "ghp_" + "a1".repeat(12);
    const providerRules = compileSecretRules({
      secretPatterns: [{ name: "Whole token", pattern: "corp_ghp_[a-z0-9]{24}!private-suffix" }],
    });
    expect(
      redactCommandParts(["sh", "-c", "echo corp_" + providerToken + "!private-suffix; run"], providerRules)
    ).toEqual(["sh", "-c", "echo <redacted>; run"]);
    const contextRules = compileSecretRules({
      secretPatterns: [{ name: "Credential context", pattern: "session PASSWORD=[a-z-]+; followup [a-z-]+" }],
    });
    expect(
      redactCommandParts(["sh", "-c", "echo session PASSWORD=synthetic-value; followup private-tail"], contextRules)
    ).toEqual(["sh", "-c", "echo <redacted>"]);
  });

  it("redacts the original custom match when structural URL or assignment rewriting would invalidate it", () => {
    const rules = compileSecretRules({
      secretPatterns: [
        { name: "URL context", pattern: "https://user:synthetic-value@example[.]test/path" },
        { name: "Assignment context", pattern: "PASSWORD=synthetic-value; followup private-tail" },
        { name: "JSON context", pattern: '"note":"private-tail"' },
      ],
    });
    expect(
      redactCommandParts(
        [
          "echo",
          "https://user:synthetic-value@example.test/path",
          "PASSWORD=synthetic-value; followup private-tail",
          '--data={"password":"synthetic-value","note":"private-tail"}',
        ],
        rules
      )
    ).toEqual(["echo", "<redacted>", "<redacted>", "<redacted>"]);
  });

  it("preserves built-in formatting and tool credential boundaries when custom rules do not match", () => {
    const unmatched = compileSecretRules({ secretPatterns: [{ name: "Internal", pattern: "corp_[a-z0-9]{12}" }] });
    const parts = [
      "curl",
      "-u",
      "synthetic-private-value",
      "Authorization:   Bearer synthetic-private-value",
      "https://user:synthetic-private-value@example.test/path?token=synthetic-private-value&mode=safe",
    ];
    expect(redactCommandParts(parts, unmatched)).toEqual(redactCommandParts(parts));
    const flagRules = compileSecretRules({ secretPatterns: [{ name: "Credential flag", pattern: "^-u$" }] });
    expect(redactCommandParts(["curl", "-u", "synthetic-private-value"], flagRules)).toEqual([
      "curl",
      "<redacted>",
      "<redacted>",
    ]);
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

import { describe, expect, it } from "vitest";
import {
  escapeMarkdownTableCell,
  escapeMarkdownText,
  markdownCodeBlock,
  markdownInlineCode,
  markdownTableCode,
  normalizeMarkdownText,
} from "../src/utils/markdown.js";

describe("markdown utilities", () => {
  it("normalizes control characters before rendering markdown", () => {
    expect(normalizeMarkdownText("one\r\ntwo\tthree")).toBe("one  two three");
  });

  it("escapes plain markdown text without hiding readable punctuation", () => {
    expect(escapeMarkdownText("Config file: [prod] | <danger>.")).toBe("Config file: \\[prod\\] \\| &lt;danger&gt;.");
  });

  it("renders inline code with enough backticks for embedded ticks", () => {
    expect(markdownInlineCode("src/`file`.ts")).toBe("`` src/`file`.ts ``");
  });

  it("keeps Git-controlled backtick runs inside fenced code blocks", () => {
    expect(markdownCodeBlock("status\n```\nnext", "text")).toBe("````text\nstatus\n```\nnext\n````");
  });

  it("renders table code without creating extra columns", () => {
    expect(markdownTableCode("src/a|`b`.ts")).toBe("<code>src/a&#124;&#96;b&#96;.ts</code>");
  });

  it("escapes table cell separators and line breaks", () => {
    expect(escapeMarkdownTableCell("one | two\nthree")).toBe("one \\| two three");
  });

  it("escapes every markdown-significant character and leaves other text untouched", () => {
    const bs = String.fromCharCode(92);
    const escaped = [...(bs + "`*_{}[]()#+!|")].map((character) => `${bs}${character}`).join("");
    expect(escapeMarkdownText(bs + "`*_{}[]()#+!|&<>")).toBe(`${escaped}&amp;&lt;&gt;`);
    expect(escapeMarkdownText("plain-text.ts é 日本 😀")).toBe("plain-text.ts é 日本 😀");
  });

  it("replaces every C0 control character and DEL with a space", () => {
    const controls = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join("") + "\u007F";
    expect(normalizeMarkdownText(`a${controls}b`)).toBe(`a${" ".repeat(33)}b`);
    expect(normalizeMarkdownText("a\u0080b")).toBe("a\\u0080b");
  });

  it("shows C1 controls and Unicode line separators literally in text and code blocks", () => {
    const controls =
      Array.from({ length: 32 }, (_, index) => String.fromCharCode(0x80 + index)).join("") + "\u2028\u2029";
    const visible = [...controls]
      .map((control) => `\\u${control.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    expect(normalizeMarkdownText(controls)).toBe(visible);
    expect(markdownInlineCode(controls)).toBe("`" + visible + "`");
    expect(markdownTableCode(controls)).toBe(`<code>${visible}</code>`);
    expect(markdownCodeBlock(`first\n${controls}\tlast`, "text")).toBe("```text\nfirst\n" + visible + "\tlast\n```");
    for (const renderer of [escapeMarkdownText, escapeMarkdownTableCell]) {
      const rendered = renderer(controls);
      for (const control of controls) {
        expect(rendered).not.toContain(control);
      }
    }
  });

  it("escapes only table-significant characters in table cells", () => {
    const bs = String.fromCharCode(92);
    const escaped = [...(bs + "`|[]")].map((character) => `${bs}${character}`).join("");
    expect(escapeMarkdownTableCell(bs + "`|[]&<>*_#")).toBe(`${escaped}&amp;&lt;&gt;*_#`);
  });

  it("shows bidirectional overrides literally so a path cannot read as another path", () => {
    const spoofed = "src/\u202egnp.exe";
    expect(normalizeMarkdownText(spoofed)).toBe("src/\\u202egnp.exe");
    expect(markdownInlineCode(spoofed)).toBe("`src/\\u202egnp.exe`");
    expect(markdownInlineCode(spoofed)).not.toContain("\u202e");
    expect(escapeMarkdownTableCell(`a\u2066b\u2069c\u200fd\u061ce`)).not.toMatch(/[\u061c\u200f\u2066\u2069]/);
    expect(markdownCodeBlock(`status ${spoofed}`)).not.toContain("\u202e");
    expect(normalizeMarkdownText("plain\u200dtext")).toBe("plain\u200dtext");
  });

  it("renders empty inline code and picks a fence longer than the longest tick run", () => {
    expect(markdownInlineCode("")).toBe("``");
    expect(markdownInlineCode("a```b`c")).toBe("```` a```b`c ````");
  });
});

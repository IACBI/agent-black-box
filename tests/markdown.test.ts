import { describe, expect, it } from "vitest";
import {
  escapeMarkdownTableCell,
  escapeMarkdownText,
  markdownInlineCode,
  markdownTableCode,
  normalizeMarkdownText
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

  it("renders table code without creating extra columns", () => {
    expect(markdownTableCode("src/a|`b`.ts")).toBe("<code>src/a&#124;&#96;b&#96;.ts</code>");
  });

  it("escapes table cell separators and line breaks", () => {
    expect(escapeMarkdownTableCell("one | two\nthree")).toBe("one \\| two three");
  });
});

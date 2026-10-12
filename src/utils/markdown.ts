// eslint-disable-next-line no-control-regex -- Repository text must not inject terminal control characters into reports.
const UNSAFE_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/g;
// Show C1 controls, Unicode line separators, and bidirectional marks literally in presentation.
const DISPLAY_CONTROL_PATTERN = /[\u0080-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
const MARKDOWN_TEXT_SPECIALS = /[\\`*_{}[\]()#+!|&<>]/g;
const MARKDOWN_TABLE_SPECIALS = /[\\`|[\]&<>]/g;
const TABLE_HTML_SPECIALS = /[&<>|`]/g;

const MARKDOWN_TEXT_REPLACEMENTS: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const TABLE_HTML_REPLACEMENTS: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "|": "&#124;",
  "`": "&#96;",
};

function replaceMarkdownSpecial(character: string): string {
  return MARKDOWN_TEXT_REPLACEMENTS[character] ?? `\\${character}`;
}

export function normalizeMarkdownText(value: string): string {
  return value.replace(UNSAFE_CONTROL_PATTERN, " ").replace(DISPLAY_CONTROL_PATTERN, showControlEscape);
}

function showControlEscape(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

export function escapeMarkdownText(value: string): string {
  return normalizeMarkdownText(value).replace(MARKDOWN_TEXT_SPECIALS, replaceMarkdownSpecial);
}

export function markdownInlineCode(value: string): string {
  const normalized = normalizeMarkdownText(value);
  const longestRun = longestBacktickRun(normalized);

  if (normalized.length === 0) {
    return "``";
  }

  if (longestRun === 0) {
    return `\`${normalized}\``;
  }

  const fence = "`".repeat(longestRun + 1);
  return `${fence} ${normalized} ${fence}`;
}

export function markdownTableCode(value: string): string {
  return `<code>${escapeHtmlForTable(normalizeMarkdownText(value))}</code>`;
}

export function markdownCodeBlock(value: string, language = ""): string {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex -- Repository text must not inject terminal control characters into reports.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(DISPLAY_CONTROL_PATTERN, showControlEscape);
  const fence = "`".repeat(Math.max(3, longestBacktickRun(normalized) + 1));

  return `${fence}${language}\n${normalized}\n${fence}`;
}

export function escapeMarkdownTableCell(value: string): string {
  return normalizeMarkdownText(value).replace(MARKDOWN_TABLE_SPECIALS, replaceMarkdownSpecial);
}

function escapeHtmlForTable(value: string): string {
  return value.replace(TABLE_HTML_SPECIALS, (character) => TABLE_HTML_REPLACEMENTS[character] ?? character);
}

function longestBacktickRun(value: string): number {
  if (!value.includes("`")) {
    return 0;
  }

  let longest = 0;
  let current = 0;

  for (const character of value) {
    if (character === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  return longest;
}

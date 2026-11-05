/**
 * The `info` field's markdown body (§4.2 — "markdown block").
 *
 * WHY THIS IS HAND-ROLLED RATHER THAN A DEPENDENCY. Every markdown library
 * produces an HTML STRING, which can only reach the page through
 * `dangerouslySetInnerHTML`, which then needs a sanitiser beside it to stay
 * safe. This body is agent-authored text arriving over the wire, so that is two
 * dependencies and a standing injection surface to render headings and bullets.
 * Parsing to React ELEMENTS instead means no HTML is ever constructed: the
 * worst an author can emit is a heading, because there is no code path that
 * turns their text into markup.
 *
 * WHAT IT SUPPORTS, and why that list ends where it does. Headings, both list
 * kinds, blockquotes, fenced and inline code, bold, italic and links — the
 * grammar a model actually writes when told "markdown". Everything outside it
 * renders as the literal text the author typed, which is the failure mode this
 * module exists to remove, so the list is meant to cover the common case rather
 * than to be small.
 *
 * TWO DELIBERATE DEPARTURES FROM COMMONMARK:
 *
 * 1. `_underscores_` are NOT italics. Field ids, computed ops and paths in this
 *    system are snake_case, so `count_needs_review` written in a sentence has a
 *    perfectly good `_needs_` inside it and would come out half-italic. The
 *    cost of dropping it is that an author who writes `_this_` sees underscores;
 *    the cost of keeping it is mangled identifiers in the one body of text most
 *    likely to contain them. Asterisks still work.
 *
 * 2. Links are NOT anchors. The text is agent-authored and the form is a
 *    surface the user is about to submit answers into, so a clickable
 *    author-controlled destination inside it is a phishing affordance for a
 *    feature nobody asked for. `[text](url)` renders as `text (url)` in plain
 *    text: nothing is hidden from the reader, nothing is clickable, and no
 *    syntax leaks.
 */

import { memo, type ReactNode } from "react";

/* -------------------------------------------------------------------------- */
/* blocks                                                                     */
/* -------------------------------------------------------------------------- */

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const FENCE = /^\s*```/;

/**
 * Lines to blocks, in one forward pass. A blank line ends whatever is open;
 * anything unrecognised is paragraph text, so no input is ever rejected.
 */
function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  /** Paragraph and quote runs are joined with "\n"; HTML renders that as a space. */
  const runWhile = (test: (line: string) => boolean, strip: (line: string) => string) => {
    const parts: string[] = [];
    while (index < lines.length && test(lines[index] as string)) {
      parts.push(strip(lines[index] as string));
      index += 1;
    }
    return parts;
  };

  while (index < lines.length) {
    const line = lines[index] as string;

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    /** Fenced code is verbatim: no inline parsing, no block parsing inside it. */
    if (FENCE.test(line)) {
      index += 1;
      const body: string[] = [];
      while (index < lines.length && !FENCE.test(lines[index] as string)) {
        body.push(lines[index] as string);
        index += 1;
      }
      /** An unterminated fence runs to the end rather than failing. */
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const hashes = (heading[1] as string).length;
      blocks.push({
        kind: "heading",
        level: hashes === 1 ? 1 : hashes === 2 ? 2 : 3,
        text: heading[2] as string,
      });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const parts = runWhile(
        (candidate) => QUOTE.test(candidate),
        (candidate) => (QUOTE.exec(candidate)?.[1] ?? "").trim(),
      );
      blocks.push({ kind: "quote", text: parts.join("\n") });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line) && !BULLET.test(line);
      const matcher = ordered ? ORDERED : BULLET;
      /**
       * One run is one list. A bullet run interrupted by a numbered line starts
       * a second list rather than silently swallowing it as a bullet.
       */
      const items = runWhile(
        (candidate) => matcher.test(candidate) && !(ordered ? BULLET : ORDERED).test(candidate),
        (candidate) => (matcher.exec(candidate)?.[1] ?? "").trim(),
      );
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const parts = runWhile(
      (candidate) =>
        candidate.trim() !== "" &&
        !HEADING.test(candidate) &&
        !BULLET.test(candidate) &&
        !ORDERED.test(candidate) &&
        !QUOTE.test(candidate) &&
        !FENCE.test(candidate),
      (candidate) => candidate,
    );
    blocks.push({ kind: "paragraph", text: parts.join("\n") });
  }

  return blocks;
}

/* -------------------------------------------------------------------------- */
/* inline                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Inline code FIRST, so `**` inside backticks stays literal; bold before
 * italic, so `**x**` is not read as an empty italic wrapping `*x*`. No
 * underscore rule — see the header.
 */
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]*\]\([^)\s]*(?:\s+"[^"\n]*")?\))/;

const LINK = /^\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"\n]*")?\)$/;

function renderInline(source: string): ReactNode[] {
  return source.split(INLINE).map((part, index) => {
    const key = `${index}`;

    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={key}
          className="rounded bg-[var(--color-surface-3,rgba(127,127,127,0.12))] px-1 font-[family-name:var(--font-mono)] text-[0.9em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }

    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }

    const link = LINK.exec(part);
    if (link) {
      const label = (link[1] as string).trim();
      const href = (link[2] as string).trim();
      /** Plain text, never an anchor (see the header). */
      if (!label) return <span key={key}>{href}</span>;
      if (!href) return <span key={key}>{label}</span>;
      return <span key={key}>{`${label} (${href})`}</span>;
    }

    return part;
  });
}

/* -------------------------------------------------------------------------- */
/* render                                                                     */
/* -------------------------------------------------------------------------- */

const PARAGRAPH = "m-0 mb-2 text-[length:var(--font-text-sm-size)]";

/**
 * Info-block headings sit below the form title (h1) and the section title (h2),
 * so they start at h3 and the document outline stays walkable.
 */
function Heading({ level, text }: { level: 1 | 2 | 3; text: string }) {
  const children = renderInline(text);
  if (level === 1) {
    return (
      <h3 className="mt-3 mb-1 text-[length:var(--font-heading-sm-size)] font-[var(--font-weight-semibold)] first:mt-0">
        {children}
      </h3>
    );
  }
  if (level === 2) {
    return (
      <h4 className="mt-3 mb-1 text-[length:var(--font-text-md-size)] font-[var(--font-weight-semibold)] first:mt-0">
        {children}
      </h4>
    );
  }
  return (
    <h5 className="mt-2 mb-1 text-[length:var(--font-text-sm-size)] font-[var(--font-weight-semibold)] text-[color:var(--color-text-secondary)] first:mt-0">
      {children}
    </h5>
  );
}

/** Agent-authored markdown, rendered to elements. No HTML is ever injected. */
export const Markdown = memo(function Markdown({ source }: { source: string }) {
  return (
    <>
      {parseBlocks(source).map((block, index) => {
        const key = `${index}`;

        if (block.kind === "heading") {
          return <Heading key={key} level={block.level} text={block.text} />;
        }

        if (block.kind === "code") {
          return (
            <pre
              key={key}
              className="m-0 mb-2 overflow-x-auto rounded bg-[var(--color-surface-3,rgba(127,127,127,0.12))] p-2 font-[family-name:var(--font-mono)] text-[length:var(--font-text-xs-size)]"
            >
              <code>{block.text}</code>
            </pre>
          );
        }

        if (block.kind === "quote") {
          return (
            <blockquote
              key={key}
              className="border-line-soft m-0 mb-2 border-l-2 pl-2 text-[length:var(--font-text-sm-size)] text-[color:var(--color-text-secondary)]"
            >
              {renderInline(block.text)}
            </blockquote>
          );
        }

        if (block.kind === "list") {
          const items = block.items.map((item, itemIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional
            <li key={itemIndex} className="mb-0.5">
              {renderInline(item)}
            </li>
          ));
          return block.ordered ? (
            <ol
              key={key}
              className="m-0 mb-2 list-decimal pl-5 text-[length:var(--font-text-sm-size)]"
            >
              {items}
            </ol>
          ) : (
            <ul
              key={key}
              className="m-0 mb-2 list-disc pl-5 text-[length:var(--font-text-sm-size)]"
            >
              {items}
            </ul>
          );
        }

        return (
          <p key={key} className={PARAGRAPH}>
            {renderInline(block.text)}
          </p>
        );
      })}
    </>
  );
});

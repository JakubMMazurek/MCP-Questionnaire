/**
 * @vitest-environment jsdom
 *
 * The `info` block's markdown renderer.
 *
 * The bug these pin down: the renderer understood paragraphs and `**bold**` and
 * nothing else, so a heading arrived on screen as a literal "### " and the
 * repo's OWN fixtures — `"## Rollout\n1. Freeze discount codes"` in
 * `__fixtures__/forms.ts` — rendered as their source text. The fixtures were
 * proven valid against the VALIDATOR and nothing proved them against the
 * RENDERER, so the two drifted silently. Hence the last test here, which reads
 * the real fixture bodies and asserts no markdown syntax survives rendering.
 */

import { archetypes } from "@mcpq/schema";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

afterEach(cleanup);

/** The rendered text, as a reader sees it. */
function textOf(source: string): string {
  const { container } = render(<Markdown source={source} />);
  return container.textContent ?? "";
}

describe("block grammar", () => {
  it("renders a heading as a heading, not as literal hashes", () => {
    render(<Markdown source="### D19 — Marking a deal Funded by hand" />);
    const heading = screen.getByRole("heading");
    expect(heading.textContent).toBe("D19 — Marking a deal Funded by hand");
    expect(heading.textContent).not.toContain("#");
  });

  it("starts info headings at h3, below the form title and the section title", () => {
    const { container } = render(<Markdown source={"# One\n\n## Two\n\n### Three"} />);
    expect([...container.querySelectorAll("h3,h4,h5")].map((node) => node.tagName)).toEqual([
      "H3",
      "H4",
      "H5",
    ]);
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")).toBeNull();
  });

  it("renders an ordered list as list items", () => {
    const { container } = render(
      <Markdown
        source={"## Rollout\n1. Freeze discount codes\n2. Migrate accounts\n3. Cut over"}
      />,
    );
    expect(container.querySelector("ol")).not.toBeNull();
    expect([...container.querySelectorAll("li")].map((node) => node.textContent)).toEqual([
      "Freeze discount codes",
      "Migrate accounts",
      "Cut over",
    ]);
  });

  it("renders a bullet list, and does not merge it into a numbered one", () => {
    const { container } = render(<Markdown source={"- alpha\n- beta\n\n1. first\n2. second"} />);
    expect(container.querySelectorAll("ul")).toHaveLength(1);
    expect(container.querySelectorAll("ol")).toHaveLength(1);
    expect(container.querySelectorAll("li")).toHaveLength(4);
  });

  it("renders a blockquote and a fenced code block", () => {
    const { container } = render(
      <Markdown
        source={"> a payment counts as Paid only when HSBC confirms it\n\n```\nnpm run x\n```"}
      />,
    );
    expect(container.querySelector("blockquote")?.textContent).toBe(
      "a payment counts as Paid only when HSBC confirms it",
    );
    expect(container.querySelector("pre")?.textContent).toBe("npm run x");
  });

  it("leaves markdown inside a fence alone", () => {
    const { container } = render(<Markdown source={"```\n## not a heading\n```"} />);
    expect(container.querySelector("heading")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("## not a heading");
  });

  it("runs an unterminated fence to the end rather than dropping the body", () => {
    expect(textOf("```\nstill shown")).toContain("still shown");
  });

  it("keeps consecutive lines in one paragraph", () => {
    const { container } = render(<Markdown source={"one\ntwo\n\nthree"} />);
    expect(container.querySelectorAll("p")).toHaveLength(2);
  });
});

describe("inline grammar", () => {
  it("renders bold and italic", () => {
    const { container } = render(<Markdown source="**Killed:** docs overhaul (*too slow*)" />);
    expect(container.querySelector("strong")?.textContent).toBe("Killed:");
    expect(container.querySelector("em")?.textContent).toBe("too slow");
  });

  it("renders inline code, and leaves markdown inside it literal", () => {
    const { container } = render(<Markdown source="call `get_answers(**formId**)` after" />);
    expect(container.querySelector("code")?.textContent).toBe("get_answers(**formId**)");
    expect(container.querySelector("strong")).toBeNull();
  });

  /**
   * The reason there is no `_italic_` rule at all: every id, op and path in this
   * system is snake_case, so the one body of text most likely to contain
   * underscores is the one least able to survive treating them as emphasis.
   */
  it("does not italicise snake_case identifiers", () => {
    const { container } = render(
      <Markdown source="counts via count_needs_review and count_empty" />,
    );
    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toBe("counts via count_needs_review and count_empty");
  });

  it("renders a link as plain text with its destination, and never as an anchor", () => {
    const { container } = render(<Markdown source="see [the ticket](https://example.com/ac5)" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("see the ticket (https://example.com/ac5)");
  });
});

describe("nothing leaks", () => {
  it("never injects HTML from the author's text", () => {
    const { container } = render(
      <Markdown source={"<img src=x onerror=alert(1)>\n\n<b>bold?</b>"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("renders every info body in the shipped fixtures without leaving syntax on screen", () => {
    type Loose = { sections: { fields: { type: string; markdown?: string }[] }[] };
    const bodies = (Object.values(archetypes) as unknown as Loose[])
      .flatMap((form) => form.sections)
      .flatMap((section) => section.fields)
      .filter((field) => field.type === "info")
      .map((field) => field.markdown ?? "");

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const rendered = textOf(body);
      expect(rendered).not.toMatch(/\*\*/);
      expect(rendered).not.toMatch(/^#{1,6}\s/m);
      cleanup();
    }
  });
});

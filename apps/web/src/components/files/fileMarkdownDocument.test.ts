import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vite-plus/test";

import {
  fileMarkdownExtensions,
  parseFileMarkdown,
  serializeFileMarkdown,
} from "./fileMarkdownDocument";

const schema = getSchema(fileMarkdownExtensions);

describe("rendered Markdown documents", () => {
  it("preserves untouched Markdown including frontmatter, CRLF, references, comments and diagrams", () => {
    const source = [
      "---",
      "title: Draft",
      "---",
      "",
      "Title",
      "=====",
      "",
      "Text with **bold**, _italics_, ~~strike~~, `code`, &amp; and [a link](https://example.com).",
      "",
      "+ [ ] First",
      "+ [x] Second",
      "",
      "<!-- keep this -->",
      "",
      "| Name | Value |",
      "| :--- | ---: |",
      "| a | 1 |",
      "",
      "[ref]: https://example.com",
      "",
      "See [reference][ref] and $x^2$.",
      "",
      "```mermaid",
      "graph LR",
      "A --> B",
      "```",
      "",
      "![Image](./image.png)",
      "",
    ].join("\r\n");
    const parsed = parseFileMarkdown(source, schema);
    expect(serializeFileMarkdown(parsed.document, parsed)).toBe(source);
    expect(parsed.document.textContent).toContain("Text with bold");
    expect(parsed.document.child(0).type.name).toBe("heading");
  });

  it("changes rendered text while keeping surrounding source and inline formatting", () => {
    const source =
      "---\ntitle: Draft\n---\n\nTitle\n=====\n\nHello **world** and [link](https://example.com).\n\n<!-- exact -->\n\n~~~mermaid\ngraph LR\nA --> B\n~~~\n";
    const parsed = parseFileMarkdown(source, schema);
    const paragraph = parsed.document.child(1);
    const changed = paragraph.copy(
      schema.nodes.paragraph!.create(null, [
        schema.text("Goodbye "),
        ...Array.from({ length: paragraph.childCount - 1 }, (_, index) =>
          paragraph.child(index + 1),
        ),
      ]).content,
    );
    const document = schema.nodes.doc!.create(null, [
      parsed.document.child(0),
      changed,
      parsed.document.child(2),
      parsed.document.child(3),
    ]);
    expect(serializeFileMarkdown(document, parsed)).toBe(source.replace("Hello ", "Goodbye "));
  });

  it("writes table cell and task changes as valid Markdown", () => {
    const source = "| Name | Value |\n| :--- | ---: |\n| a | 1 |\n\n- [ ] Task\n";
    const parsed = parseFileMarkdown(source, schema);
    const json = structuredClone(parsed.document.toJSON());
    json.content![0]!.content![1]!.content![1]!.content![0]!.content![0]!.text = "2 | 3";
    json.content![0]!.content![1]!.content![1]!.content!.push({
      type: "paragraph",
      content: [{ type: "text", text: "Next line" }],
    });
    json.content![1]!.content![0]!.attrs!.checked = true;
    const saved = serializeFileMarkdown(schema.nodeFromJSON(json), parsed);
    expect(saved).toContain("2 \\| 3");
    expect(saved).toContain("<br><br>Next line");
    expect(saved).toContain("- [x] Task");
    const reread = parseFileMarkdown(saved, schema);
    expect(reread.document.child(0).child(1).child(1).textContent).toBe("2 | 3Next line");
    expect(reread.document.child(1).child(0).attrs.checked).toBe(true);

    for (const source of [
      "+ [ ] First\n+ [X] Second\n",
      "* [ ] First\n\n* [x] Second\n",
      "1) [ ] First\n2) [x] Second\n",
      "+ [ ] First\n  * [X] Nested\n+ [x] Second\n",
      "- [ ] First\r\n- [X] Second\r\n",
    ]) {
      const parsed = parseFileMarkdown(source, schema);
      const json = structuredClone(parsed.document.toJSON());
      json.content![0]!.content![0]!.attrs!.checked = true;
      expect(serializeFileMarkdown(schema.nodeFromJSON(json), parsed)).toBe(
        source.replace("[ ]", "[x]"),
      );
      json.content![0]!.content![0]!.attrs!.checked = false;
      json.content![0]!.content![0]!.content![0]!.content![0]!.text = "Updated";
      const edited = serializeFileMarkdown(schema.nodeFromJSON(json), parsed);
      expect(edited).toMatch(
        source.startsWith("1)")
          ? /^1\) \[ \] Updated/
          : new RegExp(`^\\${source[0]} \\[ \\] Updated`),
      );
      if (source.includes("\n\n")) expect(edited).toContain("\n\n");
      if (source.includes("Nested")) expect(edited).toMatch(/\n +\* \[x\] Nested/);
    }
  });

  it("keeps new paragraphs separate when a split inherits the original source identity", () => {
    const parsed = parseFileMarkdown("First\n", schema);
    const first = parsed.document.firstChild!;
    const document = schema.nodes.doc!.create(null, [
      first,
      first.copy(schema.nodes.paragraph!.create(null, schema.text("Second")).content),
    ]);
    expect(serializeFileMarkdown(document, parsed)).toBe("First\n\nSecond\n");
    expect(serializeFileMarkdown(parsed.document, parsed)).toBe("First\n");
  });

  it("keeps multiline HTML inside an edited quote without duplicating quote markers or carriage returns", () => {
    const source = "> First\r\n>\r\n> <div>\r\n> inside\r\n> </div>\r\n";
    const parsed = parseFileMarkdown(source, schema);
    const json = structuredClone(parsed.document.toJSON());
    json.content![0]!.content![0]!.content![0]!.text = "Updated";
    const saved = serializeFileMarkdown(schema.nodeFromJSON(json), parsed);
    expect(saved).toBe(source.replace("First", "Updated"));
  });
});

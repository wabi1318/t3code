import { getSchema } from "@tiptap/core";
import { DOMParser, DOMSerializer } from "@tiptap/pm/model";
import { expect, it } from "vite-plus/test";

import {
  fileMarkdownExtensions,
  parseFileMarkdown,
  serializeFileMarkdown,
} from "./fileMarkdownDocument";

it("retains unchanged Markdown after the editor reads its DOM back", () => {
  const schema = getSchema(fileMarkdownExtensions);
  const source = "Before\n\n+ [ ] First\n\n+ [X] Second\n\n$$x^2$$\n";
  const original = parseFileMarkdown(source, schema);
  const container = document.createElement("div");
  container.append(DOMSerializer.fromSchema(schema).serializeFragment(original.document.content));
  container.querySelector("p")!.textContent = "Changed";
  const reread = DOMParser.fromSchema(schema).parse(container);
  expect(serializeFileMarkdown(reread, original)).toBe(source.replace("Before", "Changed"));
});

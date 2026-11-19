import {
  EditorState,
  Facet,
  StateEffect,
  StateField,
  Text,
  type Transaction,
} from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";

type LineEnding = "LF" | "CRLF" | "CR";
interface SourceEndings {
  readonly codes: Text;
  readonly preferred: LineEnding;
  readonly uniform: boolean;
}
const separators = { LF: "\n", CRLF: "\r\n", CR: "\r" };
const restoreEndings = StateEffect.define<SourceEndings>();
const initialSource = Facet.define<string, string>({ combine: (values) => values[0] ?? "" });

function indexEndings(text: string): SourceEndings {
  const endings: LineEnding[] = [];
  for (const match of text.matchAll(/\r\n|\r|\n/g))
    endings.push(match[0] === "\r\n" ? "CRLF" : match[0] === "\r" ? "CR" : "LF");
  const preferred = endings[0] ?? "LF";
  return {
    codes: Text.of([...endings, "END"]),
    preferred,
    uniform: endings.every((ending) => ending === preferred),
  };
}

function changesLineEndings(transaction: Transaction) {
  let changed = false;
  transaction.changes.iterChanges((from, to, _nextFrom, _nextTo, inserted) => {
    if (
      inserted.lines > 1 ||
      transaction.startState.doc.lineAt(from).number !==
        transaction.startState.doc.lineAt(to).number
    )
      changed = true;
  });
  return changed;
}

// 表示用の改行を揃えても、保存と取り消し後の本文には元の改行をそのまま残す。
const source = StateField.define<SourceEndings>({
  create: (state) => indexEndings(state.facet(initialSource)),
  update(value, transaction) {
    const restore = transaction.effects.filter((effect) => effect.is(restoreEndings)).at(-1);
    if (restore?.is(restoreEndings)) return restore.value;
    const edits: { from: number; to: number; insert: Text }[] = [];
    transaction.changes.iterChanges((from, to, _nextFrom, _nextTo, inserted) => {
      const firstLine = transaction.startState.doc.lineAt(from).number;
      const lastLine = transaction.startState.doc.lineAt(to).number;
      if (firstLine === lastLine && inserted.lines === 1) return;
      edits.push({
        from: value.codes.line(firstLine).from,
        to: value.codes.line(lastLine).from,
        insert: Text.of([...Array<string>(inserted.lines - 1).fill(value.preferred), ""]),
      });
    });
    if (!edits.length) return value;
    let codes = value.codes;
    for (const edit of edits.toReversed()) codes = codes.replace(edit.from, edit.to, edit.insert);
    return { ...value, codes };
  },
});

export function fileMarkdownSource(text: string) {
  return [
    initialSource.of(text),
    source,
    invertedEffects.of((transaction) =>
      changesLineEndings(transaction) ||
      transaction.effects.some((effect) => effect.is(restoreEndings))
        ? [restoreEndings.of(transaction.startState.field(source))]
        : [],
    ),
  ];
}

export function hasMarkdownSourceChanged(transaction: Transaction) {
  let changed = false;
  transaction.changes.iterChanges((from, to, _nextFrom, _nextTo, inserted) => {
    if (to - from !== inserted.length || !transaction.startState.doc.slice(from, to).eq(inserted))
      changed = true;
  });
  return (
    changed || !transaction.startState.field(source).codes.eq(transaction.state.field(source).codes)
  );
}

export function readMarkdownSource(state: EditorState) {
  const endings = state.field(source);
  if (endings.uniform)
    return state.doc.sliceString(0, state.doc.length, separators[endings.preferred]);
  const codes = endings.codes.iterLines();
  const result: string[] = [];
  for (const line of state.doc.iterLines()) {
    result.push(line);
    const code = codes.next().value;
    switch (code) {
      case "LF":
        result.push("\n");
        break;
      case "CRLF":
        result.push("\r\n");
        break;
      case "CR":
        result.push("\r");
        break;
      case "END":
        break;
      default:
        throw new Error("Invalid Markdown line ending");
    }
  }
  return result.join("");
}

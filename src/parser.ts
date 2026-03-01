import type { ChunkMetadata, ChunkRecord, ChildInfo, ImportInfo } from "./types.ts";
import { toYaml } from "./yaml.ts";
import { resolve } from "path";

// Lazy-initialized parser and languages
let ParserClass: any;
let initPromise: Promise<void> | null = null;
const languages: Map<string, any> = new Map();

// Find node_modules relative to this file
const PROJECT_ROOT = resolve(import.meta.dir, "..");
const WASM_DIR = resolve(PROJECT_ROOT, "node_modules/tree-sitter-wasms/out");

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
};

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // web-tree-sitter is CJS-only, use require
    const WTS = require("web-tree-sitter");
    await WTS.init();
    ParserClass = WTS;
  })();
  return initPromise;
}

async function getLanguage(langName: string): Promise<any> {
  if (languages.has(langName)) return languages.get(langName)!;
  await ensureInit();
  const wasmPath = resolve(WASM_DIR, `tree-sitter-${langName}.wasm`);
  const lang = await ParserClass.Language.load(wasmPath);
  languages.set(langName, lang);
  return lang;
}

export function getSupportedExtensions(): string[] {
  return Object.keys(EXT_TO_LANG);
}

export function isSupported(filePath: string): boolean {
  const ext = "." + filePath.split(".").pop();
  return ext in EXT_TO_LANG;
}

/** Parse a source file into chunks, one per top-level declaration. */
export async function parseFile(
  filePath: string,
  source: string
): Promise<ChunkRecord[]> {
  const ext = "." + filePath.split(".").pop();
  const langName = EXT_TO_LANG[ext];
  if (!langName) return [];

  await ensureInit();
  const lang = await getLanguage(langName);
  const parser = new ParserClass();
  parser.setLanguage(lang);

  const tree = parser.parse(source);
  const root = tree.rootNode;
  const lines = source.split("\n");

  const chunks: ChunkRecord[] = [];
  const fileImports: ImportInfo[] = [];
  let chunkIndex = 0;

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (!node) continue;

    // Collect imports but don't create chunks for them
    if (node.type === "import_statement") {
      const imp = extractImport(node);
      if (imp) fileImports.push(imp);
      continue;
    }

    const meta = extractMetadata(node, lines);
    if (!meta) continue;

    // Attach file imports to the first chunk
    if (chunkIndex === 0 && fileImports.length > 0) {
      meta.imports = fileImports;
    }

    const startLine = node.startPosition.row + 1; // 1-indexed
    const endLine = node.endPosition.row + 1;
    const body = lines.slice(node.startPosition.row, node.endPosition.row + 1).join("\n");
    const hash = new Bun.CryptoHasher("md5").update(body).digest("hex");

    chunks.push({
      filePath,
      chunkIndex,
      startLine,
      endLine,
      hash,
      body,
      metadata: toYaml(meta as unknown as Record<string, unknown>),
    });
    chunkIndex++;
  }

  return chunks;
}

function extractMetadata(
  node: any,
  lines: string[]
): ChunkMetadata | null {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  const lineRange: [number, number] = [startLine, endLine];

  // Unwrap export_statement
  if (node.type === "export_statement") {
    // Find the inner declaration
    let inner: any = null;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child.type !== "decorator") {
        inner = child;
        break;
      }
    }
    if (!inner) {
      return {
        name: "export",
        type: "export",
        line_range: lineRange,
      };
    }
    const meta = extractMetadata(inner, lines);
    if (meta) {
      meta.exports = true;
      meta.line_range = lineRange; // Use the export statement's range
    }
    return meta;
  }

  switch (node.type) {
    case "class_declaration":
      return extractClass(node, lineRange);
    case "abstract_class_declaration":
      return extractClass(node, lineRange);
    case "function_declaration":
      return extractFunction(node, lineRange);
    case "lexical_declaration":
      return extractLexical(node, lineRange);
    case "enum_declaration":
      return extractEnum(node, lineRange);
    case "interface_declaration":
      return extractInterface(node, lineRange);
    case "type_alias_declaration":
      return extractTypeAlias(node, lineRange);
    case "expression_statement":
      return {
        name: node.text.substring(0, 40).replace(/\n/g, " "),
        type: "expression",
        line_range: lineRange,
      };
    default:
      return {
        name: node.type,
        type: node.type,
        line_range: lineRange,
      };
  }
}

function extractClass(
  node: any,
  lineRange: [number, number]
): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  const children: ChildInfo[] = [];

  const body = node.childForFieldName("body");
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (!member) continue;

      if (member.type === "method_definition") {
        const methodName = member.childForFieldName("name")?.text ?? "anonymous";
        const params = extractParams(member.childForFieldName("parameters"));
        const ret = member.childForFieldName("return_type")?.text?.replace(/^:\s*/, "");
        const child: ChildInfo = {
          name: methodName,
          type: "method",
          line_range: [member.startPosition.row + 1, member.endPosition.row + 1],
        };
        if (params.length > 0) child.params = params;
        if (ret) child.returns = ret;
        children.push(child);
      } else if (member.type === "public_field_definition") {
        const fieldName = member.childForFieldName("name")?.text ?? "anonymous";
        children.push({
          name: fieldName,
          type: "property",
          line_range: [member.startPosition.row + 1, member.endPosition.row + 1],
        });
      }
    }
  }

  const meta: ChunkMetadata = { name, type: "class", line_range: lineRange };
  if (children.length > 0) meta.children = children;
  return meta;
}

function extractFunction(
  node: any,
  lineRange: [number, number]
): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  const params = extractParams(node.childForFieldName("parameters"));
  const ret = node.childForFieldName("return_type")?.text?.replace(/^:\s*/, "");

  const meta: ChunkMetadata = { name, type: "function", line_range: lineRange };
  if (params.length > 0) meta.params = params;
  if (ret) meta.returns = ret;
  return meta;
}

function extractLexical(
  node: any,
  lineRange: [number, number]
): ChunkMetadata {
  // Get const/let keyword
  let kind = "const";
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "const" || child.text === "const") kind = "const";
    else if (child.type === "let" || child.text === "let") kind = "let";
  }

  const declarator = node.namedChild(0);
  const name = declarator?.childForFieldName("name")?.text ?? "anonymous";

  // Check if it's an arrow function
  const value = declarator?.childForFieldName("value");
  if (value?.type === "arrow_function") {
    const params = extractParams(value.childForFieldName("parameters"));
    const ret = value.childForFieldName("return_type")?.text?.replace(/^:\s*/, "");
    const meta: ChunkMetadata = { name, type: kind, line_range: lineRange };
    if (params.length > 0) meta.params = params;
    if (ret) meta.returns = ret;
    return meta;
  }

  return { name, type: kind, line_range: lineRange };
}

function extractEnum(
  node: any,
  lineRange: [number, number]
): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  return { name, type: "enum", line_range: lineRange };
}

function extractInterface(
  node: any,
  lineRange: [number, number]
): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  return { name, type: "interface", line_range: lineRange };
}

function extractTypeAlias(
  node: any,
  lineRange: [number, number]
): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  return { name, type: "type", line_range: lineRange };
}

function extractParams(paramsNode: any): string[] {
  if (!paramsNode) return [];
  const params: string[] = [];
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    params.push(paramsNode.namedChild(i).text);
  }
  return params;
}

function extractImport(node: any): ImportInfo | null {
  // import { Foo } from './foo'
  // import Foo from './foo'
  let name = "";
  let from = "";

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === "import_clause") {
      name = child.text;
    } else if (child.type === "string") {
      from = child.text.replace(/['"]/g, "");
    }
  }

  if (name && from) return { name, from };
  return null;
}

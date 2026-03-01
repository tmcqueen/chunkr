import type { ChunkRecord, ImportInfo } from "./types.ts";
import type { LanguageSupport } from "./languages/registry.ts";
import { getLanguageSupport } from "./languages/registry.ts";
import { toYaml } from "./yaml.ts";
import { resolve } from "path";

// Side-effect imports to register languages
import "./languages/typescript.ts";
import "./languages/csharp.ts";

// Lazy-initialized parser
let ParserClass: any;
let initPromise: Promise<void> | null = null;
const grammars: Map<string, any> = new Map();

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const WASM_DIR = resolve(PROJECT_ROOT, "node_modules/tree-sitter-wasms/out");

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const WTS = require("web-tree-sitter");
    await WTS.init();
    ParserClass = WTS;
  })();
  return initPromise;
}

async function getGrammar(grammarName: string): Promise<any> {
  if (grammars.has(grammarName)) return grammars.get(grammarName)!;
  await ensureInit();
  const wasmPath = resolve(WASM_DIR, `tree-sitter-${grammarName}.wasm`);
  const lang = await ParserClass.Language.load(wasmPath);
  grammars.set(grammarName, lang);
  return lang;
}

function getGrammarForFile(langSupport: LanguageSupport, filePath: string): string {
  const ext = "." + filePath.split(".").pop();
  if (langSupport.grammarForExtension?.[ext]) {
    return langSupport.grammarForExtension[ext];
  }
  return langSupport.grammarName;
}

export function getSupportedExtensions(langName: string): string[] {
  return getLanguageSupport(langName).extensions;
}

export function isSupported(langName: string, filePath: string): boolean {
  const ext = "." + filePath.split(".").pop();
  return getLanguageSupport(langName).extensions.includes(ext);
}

/** Parse a source file into chunks using the specified language. */
export async function parseFile(
  langName: string,
  filePath: string,
  source: string
): Promise<ChunkRecord[]> {
  const langSupport = getLanguageSupport(langName);
  const grammarName = getGrammarForFile(langSupport, filePath);

  await ensureInit();
  const grammar = await getGrammar(grammarName);
  const parser = new ParserClass();
  parser.setLanguage(grammar);

  const tree = parser.parse(source);
  const root = tree.rootNode;
  const lines = source.split("\n");

  const chunks: ChunkRecord[] = [];
  const fileImports: ImportInfo[] = [];
  let chunkIndex = 0;

  function processNode(node: any): void {
    // Collect imports
    if (langSupport.importNodeTypes.includes(node.type)) {
      const imp = langSupport.extractImport(node);
      if (imp) fileImports.push(imp);
      return;
    }

    // Unwrap namespace-like nodes
    if (langSupport.unwrapNodeTypes.includes(node.type)) {
      if (node.type === "namespace_declaration") {
        const body = node.childForFieldName("body");
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (child) processNode(child);
          }
        }
      } else {
        // file_scoped_namespace_declaration — skip qualified_name
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child && child.type !== "qualified_name") {
            processNode(child);
          }
        }
      }
      return;
    }

    const meta = langSupport.extractMetadata(node, lines);
    if (!meta) return;

    // Attach file imports to the first chunk
    if (chunkIndex === 0 && fileImports.length > 0) {
      meta.imports = fileImports;
    }

    const startLine = node.startPosition.row + 1;
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

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (node) processNode(node);
  }

  return chunks;
}

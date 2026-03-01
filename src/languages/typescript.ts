import { registerLanguage } from "./registry.ts";
import type { LanguageSupport } from "./registry.ts";
import type { ChunkMetadata, ChildInfo, ImportInfo } from "../types.ts";

function extractMetadata(
  node: any,
  lines: string[]
): ChunkMetadata | null {
  // Unwrap export_statement
  if (node.type === "export_statement") {
    let inner: any = null;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child.type !== "decorator") {
        inner = child;
        break;
      }
    }
    if (!inner) {
      return { name: "export", type: "export" };
    }
    const meta = extractMetadata(inner, lines);
    if (meta) {
      meta.exports = true;
    }
    return meta;
  }

  switch (node.type) {
    case "class_declaration":
    case "abstract_class_declaration":
      return extractClass(node);
    case "function_declaration":
      return extractFunction(node);
    case "lexical_declaration":
      return extractLexical(node);
    case "enum_declaration":
      return extractEnum(node);
    case "interface_declaration":
      return extractInterface(node);
    case "type_alias_declaration":
      return extractTypeAlias(node);
    case "expression_statement":
      return {
        name: node.text.substring(0, 40).replace(/\n/g, " "),
        type: "expression",
      };
    default:
      return { name: node.type, type: node.type };
  }
}

function extractClass(node: any): ChunkMetadata {
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
        const child: ChildInfo = { name: methodName, type: "method" };
        if (params.length > 0) child.params = params;
        if (ret) child.returns = ret;
        children.push(child);
      } else if (member.type === "public_field_definition") {
        const fieldName = member.childForFieldName("name")?.text ?? "anonymous";
        children.push({ name: fieldName, type: "property" });
      }
    }
  }

  const meta: ChunkMetadata = { name, type: "class" };
  if (children.length > 0) meta.children = children;
  return meta;
}

function extractFunction(node: any): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  const params = extractParams(node.childForFieldName("parameters"));
  const ret = node.childForFieldName("return_type")?.text?.replace(/^:\s*/, "");

  const meta: ChunkMetadata = { name, type: "function" };
  if (params.length > 0) meta.params = params;
  if (ret) meta.returns = ret;
  return meta;
}

function extractLexical(node: any): ChunkMetadata {
  let kind = "const";
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "const" || child.text === "const") kind = "const";
    else if (child.type === "let" || child.text === "let") kind = "let";
  }

  const declarator = node.namedChild(0);
  const name = declarator?.childForFieldName("name")?.text ?? "anonymous";

  const value = declarator?.childForFieldName("value");
  if (value?.type === "arrow_function") {
    const params = extractParams(value.childForFieldName("parameters"));
    const ret = value.childForFieldName("return_type")?.text?.replace(/^:\s*/, "");
    const meta: ChunkMetadata = { name, type: kind };
    if (params.length > 0) meta.params = params;
    if (ret) meta.returns = ret;
    return meta;
  }

  return { name, type: kind };
}

function extractEnum(node: any): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  return { name, type: "enum" };
}

function extractInterface(node: any): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  return { name, type: "interface" };
}

function extractTypeAlias(node: any): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  return { name, type: "type" };
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

const typescript: LanguageSupport = {
  extensions: [".ts", ".tsx", ".js", ".jsx"],
  grammarName: "typescript",
  grammarForExtension: {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "javascript",
  },
  extractMetadata,
  extractImport,
  importNodeTypes: ["import_statement"],
  unwrapNodeTypes: [],
};

registerLanguage("typescript", typescript);

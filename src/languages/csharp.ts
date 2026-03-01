import { registerLanguage } from "./registry.ts";
import type { LanguageSupport } from "./registry.ts";
import type { ChunkMetadata, ChildInfo, ImportInfo } from "../types.ts";

function extractMetadata(node: any, lines: string[]): ChunkMetadata | null {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  const lineRange: [number, number] = [startLine, endLine];

  switch (node.type) {
    case "class_declaration":
      return extractTypeDecl(node, "class", lineRange);
    case "interface_declaration":
      return extractTypeDecl(node, "interface", lineRange);
    case "struct_declaration":
      return extractTypeDecl(node, "struct", lineRange);
    case "record_declaration":
      return extractRecord(node, lineRange);
    case "enum_declaration":
      return extractEnum(node, lineRange);
    case "method_declaration":
      return extractMethod(node, lineRange);
    case "global_statement":
      return {
        name: node.text.substring(0, 40).replace(/\n/g, " "),
        type: "expression",
        line_range: lineRange,
      };
    default:
      return { name: node.type, type: node.type, line_range: lineRange };
  }
}

function extractTypeDecl(
  node: any,
  type: string,
  lineRange: [number, number]
): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  const children: ChildInfo[] = [];

  const body = node.childForFieldName("body");
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (!member) continue;

      if (member.type === "method_declaration") {
        const child = extractMethodChild(member);
        if (child) children.push(child);
      } else if (member.type === "constructor_declaration") {
        const child = extractConstructorChild(member);
        if (child) children.push(child);
      } else if (member.type === "property_declaration") {
        const child = extractPropertyChild(member);
        if (child) children.push(child);
      }
    }
  }

  const bases = node.childForFieldName("bases");
  const meta: ChunkMetadata = { name, type, line_range: lineRange };
  if (bases) {
    meta.returns = bases.text.replace(/^:\s*/, "");
  }
  if (children.length > 0) meta.children = children;
  return meta;
}

function extractRecord(
  node: any,
  lineRange: [number, number]
): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  const params = extractParams(node.childForFieldName("parameters"));
  const meta: ChunkMetadata = { name, type: "record", line_range: lineRange };
  if (params.length > 0) meta.params = params;

  const children: ChildInfo[] = [];
  const body = node.childForFieldName("body");
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (!member) continue;
      if (member.type === "method_declaration") {
        const child = extractMethodChild(member);
        if (child) children.push(child);
      } else if (member.type === "property_declaration") {
        const child = extractPropertyChild(member);
        if (child) children.push(child);
      }
    }
  }
  if (children.length > 0) meta.children = children;
  return meta;
}

function extractEnum(
  node: any,
  lineRange: [number, number]
): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  return { name, type: "enum", line_range: lineRange };
}

function extractMethod(
  node: any,
  lineRange: [number, number]
): ChunkMetadata {
  const name = node.childForFieldName("name")?.text ?? "anonymous";
  const returnType = node.childForFieldName("type")?.text;
  const params = extractParams(node.childForFieldName("parameters"));
  const meta: ChunkMetadata = { name, type: "method", line_range: lineRange };
  if (params.length > 0) meta.params = params;
  if (returnType) meta.returns = returnType;
  return meta;
}

function extractMethodChild(member: any): ChildInfo | null {
  const name = member.childForFieldName("name")?.text ?? "anonymous";
  const returnType = member.childForFieldName("type")?.text;
  const params = extractParams(member.childForFieldName("parameters"));
  const child: ChildInfo = {
    name,
    type: "method",
    line_range: [member.startPosition.row + 1, member.endPosition.row + 1],
  };
  if (params.length > 0) child.params = params;
  if (returnType) child.returns = returnType;
  return child;
}

function extractConstructorChild(member: any): ChildInfo | null {
  const name = member.childForFieldName("name")?.text ?? "anonymous";
  const params = extractParams(member.childForFieldName("parameters"));
  const child: ChildInfo = {
    name,
    type: "constructor",
    line_range: [member.startPosition.row + 1, member.endPosition.row + 1],
  };
  if (params.length > 0) child.params = params;
  return child;
}

function extractPropertyChild(member: any): ChildInfo | null {
  const name = member.childForFieldName("name")?.text ?? "anonymous";
  const propType = member.childForFieldName("type")?.text;
  const child: ChildInfo = {
    name,
    type: "property",
    line_range: [member.startPosition.row + 1, member.endPosition.row + 1],
  };
  if (propType) child.returns = propType;
  return child;
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
  if (node.type !== "using_directive") return null;
  let name = "";
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === "identifier" || child.type === "qualified_name") {
      name = child.text;
    }
  }
  if (name) return { name, from: name };
  return null;
}

const csharp: LanguageSupport = {
  extensions: [".cs"],
  grammarName: "c_sharp",
  extractMetadata,
  extractImport,
  importNodeTypes: ["using_directive"],
  unwrapNodeTypes: ["namespace_declaration", "file_scoped_namespace_declaration"],
};

registerLanguage("csharp", csharp);

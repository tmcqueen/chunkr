/** Minimal YAML serializer — write-only, no parsing needed. */
export function toYaml(obj: Record<string, unknown>, indent = 0): string {
  const pad = "  ".repeat(indent);
  let out = "";

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    out += `${pad}${key}: ${formatValue(value, indent)}\n`;
  }

  return out;
}

function formatValue(value: unknown, indent: number): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return quoteString(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    // Simple scalar arrays on one line: [a, b, c]
    if (value.every((v) => typeof v !== "object" || v === null)) {
      return `[${value.map((v) => formatValue(v, indent)).join(", ")}]`;
    }
    // Array of objects
    const pad = "  ".repeat(indent + 1);
    return (
      "\n" +
      value
        .map((item) => {
          const inner = toYaml(item as Record<string, unknown>, indent + 2);
          // First key gets the "- " prefix, rest are indented
          const lines = inner.trimEnd().split("\n");
          return `${pad}- ${lines[0].trimStart()}\n${lines
            .slice(1)
            .map((l) => `${pad}  ${l.trimStart()}`)
            .join("\n")}`;
        })
        .map((s) => s.trimEnd())
        .join("\n")
    );
  }

  if (typeof value === "object") {
    return "\n" + toYaml(value as Record<string, unknown>, indent + 1);
  }

  return String(value);
}

function quoteString(s: string): string {
  // Multi-line strings use block scalar
  if (s.includes("\n")) {
    const lines = s.split("\n");
    const pad = "  ".repeat(1);
    return `|\n${lines.map((l) => pad + l).join("\n")}`;
  }
  // Quote if contains special YAML characters
  if (/[:{}\[\],&*?|>!%@`#'"]/.test(s) || s === "" || s === "true" || s === "false") {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

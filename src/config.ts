import { resolve } from "path";

export interface ChunkrConfig {
  lang: string;
}

const CONFIG_FILENAME = ".chunkr.json";
const DEFAULT_LANG = "typescript";

/** Read .chunkr.json from the project root. Returns null if not found. */
export function readConfig(rootDir: string): ChunkrConfig | null {
  const configPath = resolve(rootDir, CONFIG_FILENAME);
  try {
    const text = require("fs").readFileSync(configPath, "utf-8");
    return JSON.parse(text) as ChunkrConfig;
  } catch {
    return null;
  }
}

/** Write .chunkr.json to the project root. */
export function writeConfig(rootDir: string, config: ChunkrConfig): void {
  const configPath = resolve(rootDir, CONFIG_FILENAME);
  require("fs").writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** Get the language for a project, falling back to default. */
export function getProjectLang(rootDir: string): string {
  const config = readConfig(rootDir);
  return config?.lang ?? DEFAULT_LANG;
}

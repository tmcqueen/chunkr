export interface FileRecord {
  path: string;
  hash: string;
  gitCommit: string | null;
  lastIndexed: number;
}

export interface ChunkRecord {
  id?: number;
  filePath: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  hash: string;
  body: string;
  metadata: string; // YAML blob
}

export interface ChildInfo {
  name: string;
  type: string;
  params?: string[];
  returns?: string;
  line_range: [number, number];
}

export interface ImportInfo {
  name: string;
  from: string;
}

export interface ChunkMetadata {
  name: string;
  type: string;
  exports?: boolean;
  children?: ChildInfo[];
  imports?: ImportInfo[];
  params?: string[];
  returns?: string;
  line_range: [number, number];
  description?: string | null;
}

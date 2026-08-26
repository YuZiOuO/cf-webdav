import type { ByteRange } from "./object_store";

declare const nodeIdType: unique symbol;

/**
 * A canonical absolute filesystem path using "/" separators.
 * Components are decoded strings; non-root paths contain no empty, ".", or
 * ".." segments and have no trailing separator.
 */
export type Path = string;

/** A stable filesystem node identity. */
export type NodeId = string & {
  readonly [nodeIdType]: "NodeId";
};

export interface NodeBase {
  id: NodeId;
  createdAt: Date;
  lastModified: Date;
}

export interface FileNode extends NodeBase {
  kind: "file";
  size: number;
}

export interface DirectoryNode extends NodeBase {
  kind: "directory";
}

export type Node = FileNode | DirectoryNode;

/** A named mapping from a directory to a node. */
export interface DirectoryEntry {
  name: string;
  node: Node;
}

export interface FileContent {
  file: FileNode;
  body: ReadableStream<Uint8Array>;
  range?: ByteRange;
}

/**
 * Filesystem semantics over a hierarchical namespace. A node has a stable
 * identity; paths name directory entries and may change without changing it.
 */
export interface FileSystem {
  stat(path: Path): Promise<Node | undefined>;
  readFile(path: Path, options?: { range?: ByteRange }): Promise<FileContent>;
  readdir(path: Path): AsyncIterable<DirectoryEntry>;
  writeFile(path: Path, body: ReadableStream<Uint8Array>): Promise<FileNode>;
  mkdir(path: Path): Promise<DirectoryNode>;
  remove(path: Path, options?: { recursive?: boolean }): Promise<void>;
  copy(
    source: Path,
    destination: Path,
    options: { recursive: boolean; overwrite: boolean },
  ): Promise<Node>;
  move(
    source: Path,
    destination: Path,
    options: { overwrite: boolean },
  ): Promise<Node>;
}

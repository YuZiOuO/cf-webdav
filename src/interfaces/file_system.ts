import type { ByteRange, EntityTag, Preconditions } from "./object_store";

declare const pathType: unique symbol;
declare const resourceIdType: unique symbol;

/** A canonical, decoded absolute filesystem path. */
export type Path = string & {
  readonly [pathType]: "Path";
};

/** A stable filesystem resource identity. */
export type ResourceId = string & {
  readonly [resourceIdType]: "ResourceId";
};

export interface ResourceBase {
  id: ResourceId;
  etag: EntityTag;
  createdAt: Date;
  lastModified: Date;
}

export interface File extends ResourceBase {
  kind: "file";
  size: number;
  contentType?: string;
}

export interface Directory extends ResourceBase {
  kind: "directory";
}

export type Resource = File | Directory;

/** A named mapping from a directory to a resource. */
export interface DirectoryEntry {
  name: string;
  resource: Resource;
}

export interface FileData {
  body: ReadableStream<Uint8Array>;
  size: number;
  contentType?: string;
}

export interface FileContent {
  file: File;
  body: ReadableStream<Uint8Array>;
  range?: ByteRange;
}

export interface ReadFileOptions {
  range?: ByteRange;
  preconditions?: Preconditions;
}

export interface WriteFileOptions {
  preconditions?: Preconditions;
}

export interface RemoveOptions {
  recursive?: boolean;
}

export interface CopyOptions {
  recursive: boolean;
  overwrite: boolean;
}

export interface MoveOptions {
  overwrite: boolean;
}

/** Storage quota for a filesystem path. */
export interface StorageQuota {
  usedBytes: number;
  /** Omitted when the quota is unlimited or unknown. */
  availableBytes?: number;
}

/** Optional filesystem capability for reporting storage quotas. */
export interface StorageQuotaProvider {
  getQuota(path: Path): Promise<StorageQuota>;
}

/**
 * Filesystem semantics over object content. A resource has a stable identity;
 * a path is only a directory entry and may change without changing that
 * identity.
 */
export interface FileSystem {
  stat(path: Path): Promise<Resource | undefined>;
  readFile(path: Path, options?: ReadFileOptions): Promise<FileContent>;
  readdir(path: Path): AsyncIterable<DirectoryEntry>;
  writeFile(
    path: Path,
    data: FileData,
    options?: WriteFileOptions,
  ): Promise<File>;
  mkdir(path: Path): Promise<Directory>;
  remove(path: Path, options?: RemoveOptions): Promise<void>;
  copy(
    source: Path,
    destination: Path,
    options: CopyOptions,
  ): Promise<Resource>;
  move(
    source: Path,
    destination: Path,
    options: MoveOptions,
  ): Promise<Resource>;
}

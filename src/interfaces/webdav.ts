import type {
  Directory,
  FileSystem,
  Path,
  Resource,
  ResourceId,
} from "./file_system";

declare const lockTokenType: unique symbol;
declare const syncTokenType: unique symbol;

export type LockToken = string & {
  readonly [lockTokenType]: "LockToken";
};

export type SyncToken = string & {
  readonly [syncTokenType]: "SyncToken";
};

/** An XML expanded name: namespace URI plus local name. */
export interface DavPropertyName {
  namespaceURI: string;
  localName: string;
}

/** A WebDAV property represented by its XML element. */
export interface DavProperty {
  name: DavPropertyName;
  value: Element;
}

export interface PropertyUpdate {
  set: readonly DavProperty[];
  remove: readonly DavPropertyName[];
}

/** RFC 4918 dead-property persistence, keyed by stable resource identity. */
export interface DeadPropertyStore {
  get(
    resource: ResourceId,
    names?: readonly DavPropertyName[],
  ): Promise<readonly DavProperty[]>;
  patch(resource: ResourceId, update: PropertyUpdate): Promise<void>;
}

/** Supplies computed WebDAV live properties without expanding Resource. */
export interface LivePropertyProvider {
  readonly names: readonly DavPropertyName[];
  get(
    path: Path,
    resource: Resource,
    name: DavPropertyName,
  ): Promise<DavProperty | undefined>;
}

export type LockScope = "exclusive" | "shared";
export type LockDepth = "0" | "infinity";
export type LockTimeout = number | "infinite";

export interface Lock {
  token: LockToken;
  scope: LockScope;
  depth: LockDepth;
  timeout?: LockTimeout;
}

export interface LockRequest {
  scope: LockScope;
  depth: LockDepth;
  timeout?: LockTimeout;
}

/** RFC 4918 Class 2 locking, rooted at a filesystem path. */
export interface LockManager {
  lock(path: Path, request: LockRequest): Promise<Lock>;
  refresh(path: Path, token: LockToken, timeout?: LockTimeout): Promise<Lock>;
  unlock(path: Path, token: LockToken): Promise<void>;
}

export type SyncLevel = "1" | "infinite";

export interface SyncRequest {
  syncToken?: SyncToken;
  syncLevel: SyncLevel;
  limit?: number;
}

/** A missing resource denotes a member removed since the requested token. */
export interface SyncChange {
  path: Path;
  resource?: Resource;
}

export interface SyncResult {
  changes: readonly SyncChange[];
  syncToken: SyncToken;
  truncated: boolean;
}

/** RFC 6578 sync-collection report semantics. */
export interface SyncCollection {
  sync(collection: Path, request: SyncRequest): Promise<SyncResult>;
}

/** RFC 4331 quota and size properties for a collection. */
export interface Quota {
  availableBytes: number;
  usedBytes: number;
}

export interface QuotaProvider {
  getQuota(collection: Path): Promise<Quota | undefined>;
}

/** RFC 5689 extended MKCOL; creation and property initialization are atomic. */
export interface ExtendedMkcol {
  createCollection(
    path: Path,
    properties: readonly DavProperty[],
  ): Promise<Directory>;
}

/** Dependencies owned by a future WebDAV/Hono adapter. */
export interface WebDavServices {
  fileSystem: FileSystem;
  deadProperties?: DeadPropertyStore;
  liveProperties?: readonly LivePropertyProvider[];
  locks?: LockManager;
  syncCollection?: SyncCollection;
  quota?: QuotaProvider;
  extendedMkcol?: ExtendedMkcol;
}

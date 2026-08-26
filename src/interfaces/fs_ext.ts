import type { NodeId, Path } from "./fs";

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
 * Generic inode/node extended attributes, modeled after Linux xattrs.
 * Attribute values are opaque bytes and are bound to a stable NodeId, not a
 * path. A provider should replace or return each complete value atomically.
 */
export interface XAttrProvider {
  getXattr(nodeId: NodeId, name: string): Promise<Uint8Array | undefined>;
  listXattrs(nodeId: NodeId): Promise<readonly string[]>;
  setXattr(
    nodeId: NodeId,
    name: string,
    value: Uint8Array,
    options?: { mode?: "upsert" | "create" | "replace" },
  ): Promise<void>;
  removeXattr(nodeId: NodeId, name: string): Promise<void>;
}

declare const changeCursorType: unique symbol;

/** An opaque position in a durable filesystem change journal. */
export type ChangeCursor = string & {
  readonly [changeCursorType]: "ChangeCursor";
};

/** A namespace or node change recorded by a ChangeFeedProvider. */
export type NodeChange =
  | { kind: "created"; nodeId: NodeId; path: Path }
  | { kind: "modified"; nodeId: NodeId; path: Path }
  | { kind: "deleted"; nodeId: NodeId; path: Path }
  | {
      kind: "moved";
      nodeId: NodeId;
      previousPath: Path;
      path: Path;
    };

/** An atomically committed group of related changes. */
export interface ChangeSet {
  /** Cursor immediately after this committed change set. */
  cursor: ChangeCursor;
  changes: readonly NodeChange[];
}

export interface ChangeFeedPage {
  sets: readonly ChangeSet[];
  /** Cursor to use as `after` for the next page. */
  nextCursor: ChangeCursor;
  hasMore: boolean;
}

/**
 * Durable, replayable change history. Cursors should include enough opaque
 * journal identity for a provider to reject expired or unrelated cursors.
 */
export interface ChangeFeedProvider {
  getCurrentCursor(): Promise<ChangeCursor>;
  readChanges(
    after: ChangeCursor,
    options?: { limit?: number },
  ): Promise<ChangeFeedPage>;
}

export interface LockOwner {
  /** A client/session identity used for lease and crash cleanup. */
  sessionId: string;
  /** An owner identity within the session, such as an open-file owner. */
  ownerId: string;
}

/** A byte range using fcntl semantics: non-negative length 0 means through EOF. */
export interface LockRange {
  start: bigint;
  length: bigint;
}

export type RecordLockType = "read" | "write";

export interface RecordLockRequest {
  type: RecordLockType | "unlock";
  range: LockRange;
}

export interface RecordLockQuery {
  type: RecordLockType;
  range: LockRange;
}

export interface LockConflict {
  owner: LockOwner;
  type: Exclude<RecordLockType, "unlock">;
  range: LockRange;
}

export type FlockType = "shared" | "exclusive" | "unlock";

/**
 * Optional advisory locking capability for FUSE/NFS-style adapters.
 * `getLock`/`setLock` model fcntl byte-range locks; `flock` is a separate
 * whole-file lock namespace, as it is on Linux and FUSE.
 */
export interface PosixLockProvider {
  getLock(
    nodeId: NodeId,
    owner: LockOwner,
    request: RecordLockQuery,
  ): Promise<LockConflict | undefined>;

  setLock(
    nodeId: NodeId,
    owner: LockOwner,
    request: RecordLockRequest,
    options?: { wait?: boolean },
  ): Promise<void>;

  flock(
    nodeId: NodeId,
    owner: LockOwner,
    type: FlockType,
    options?: { wait?: boolean },
  ): Promise<void>;

  /** Release all record and flock locks held by one owner. */
  releaseOwner(owner: LockOwner): Promise<void>;

  /** Renew the session lease; expired sessions must lose their locks. */
  renewSession(sessionId: string): Promise<void>;
}

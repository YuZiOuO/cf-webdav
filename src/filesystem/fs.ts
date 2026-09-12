import type {
  ChangeCursor,
  ChangeFeedProvider,
  ChangeFeedPage,
  DirectoryEntry,
  FileNode,
  FileSystem,
  FlockType,
  LockConflict,
  LockOwner,
  LockRange,
  Node,
  NodeChange,
  NodeId,
  NamespaceLock,
  NamespaceLockProvider,
  NamespaceLockRequest,
  ObjectStore,
  Path,
  PosixLockProvider,
  RecordLockQuery,
  RecordLockRequest,
  StorageQuota,
  StorageQuotaProvider,
  XAttrChange,
  XAttrProvider,
} from "../interfaces";
import { copy } from "./vfs/copy";
import { move } from "./vfs/move";
import { readFile, readdir, stat } from "./vfs/read";
import { remove } from "./vfs/remove";
import { mkdir, writeFile } from "./vfs/write";
import type {
  FileSystemState,
  StoredNodeChange,
  StoredLockRange,
  StoredNamespaceLock,
} from "./meta";
import { unwrapState } from "./meta";

const toStoredRange = (range: LockRange): StoredLockRange => ({
  start: range.start.toString(),
  length: range.length.toString(),
});

const toLockRange = (range: StoredLockRange): LockRange => ({
  start: BigInt(range.start),
  length: BigInt(range.length),
});

const toNodeChange = (change: StoredNodeChange): NodeChange => {
  switch (change.kind) {
    case "created":
      return {
        kind: "created",
        nodeId: change.nodeId as NodeId,
        path: change.path,
      };
    case "modified":
      return {
        kind: "modified",
        nodeId: change.nodeId as NodeId,
        path: change.path,
      };
    case "deleted":
      return {
        kind: "deleted",
        nodeId: change.nodeId as NodeId,
        path: change.path,
      };
    case "moved":
      return {
        kind: "moved",
        nodeId: change.nodeId as NodeId,
        previousPath: change.previousPath,
        path: change.path,
      };
  }
};

const toNamespaceLock = (lock: StoredNamespaceLock): NamespaceLock => ({
  token: lock.token,
  root: lock.root,
  scope: lock.scope,
  depth: lock.depth,
  ...(lock.timeout === undefined ? {} : { timeout: lock.timeout }),
  ...(lock.owner === undefined ? {} : { owner: lock.owner }),
});

export class ObjectStoreFileSystem
  implements
    FileSystem,
    StorageQuotaProvider,
    XAttrProvider,
    ChangeFeedProvider,
    PosixLockProvider,
    NamespaceLockProvider
{
  private readonly objects: ObjectStore;
  private readonly state: DurableObjectStub<FileSystemState>;

  constructor(objects: ObjectStore, state: DurableObjectStub<FileSystemState>) {
    this.objects = objects;
    this.state = state;
  }

  private deps() {
    return { objects: this.objects, state: this.state };
  }

  stat(path: Path) {
    return stat(this.deps(), path);
  }

  readFile(path: Path, options?: { range?: { start: number; end?: number } }) {
    return readFile(this.deps(), path, options);
  }

  readdir(path: Path): AsyncIterable<DirectoryEntry> {
    return readdir(this.deps(), path);
  }

  writeFile(path: Path, body: ReadableStream<Uint8Array>): Promise<FileNode> {
    return writeFile(this.deps(), path, body);
  }

  mkdir(path: Path) {
    return mkdir(this.deps(), path);
  }

  remove(path: Path, options?: { recursive?: boolean }) {
    return remove(this.deps(), path, options);
  }

  copy(
    source: Path,
    destination: Path,
    options: { recursive: boolean; overwrite: boolean },
  ): Promise<Node> {
    return copy(this.deps(), source, destination, options);
  }

  move(
    source: Path,
    destination: Path,
    options: { overwrite: boolean },
  ): Promise<Node> {
    return move(this.deps(), source, destination, options);
  }

  async getQuota(path: Path): Promise<StorageQuota> {
    return { usedBytes: await this.state.usedBytes(path) };
  }

  async getXattr(nodeId: NodeId, name: string) {
    return unwrapState(await this.state.getXattr(nodeId, name));
  }

  async listXattrs(nodeId: NodeId) {
    return unwrapState(await this.state.listXattrs(nodeId));
  }

  async setXattr(
    nodeId: NodeId,
    name: string,
    value: Uint8Array,
    options?: { mode?: "upsert" | "create" | "replace" },
  ): Promise<void> {
    unwrapState(
      await this.state.setXattr(nodeId, name, value, options?.mode ?? "upsert"),
    );
  }

  async removeXattr(nodeId: NodeId, name: string): Promise<void> {
    unwrapState(await this.state.removeXattr(nodeId, name));
  }

  async patchXattrs(
    nodeId: NodeId,
    changes: readonly XAttrChange[],
  ): Promise<void> {
    unwrapState(await this.state.patchXattrs(nodeId, changes));
  }

  async getNamespaceLocks(path: Path): Promise<readonly NamespaceLock[]> {
    return unwrapState(await this.state.getNamespaceLocks(path)).map(
      toNamespaceLock,
    );
  }

  async createNamespaceLock(
    path: Path,
    request: NamespaceLockRequest,
  ): Promise<NamespaceLock> {
    return toNamespaceLock(
      unwrapState(await this.state.createNamespaceLock(path, request)),
    );
  }

  async refreshNamespaceLock(
    path: Path,
    token: string,
    timeout?: number,
  ): Promise<NamespaceLock> {
    return toNamespaceLock(
      unwrapState(await this.state.refreshNamespaceLock(path, token, timeout)),
    );
  }

  async unlockNamespaceLock(path: Path, token: string): Promise<void> {
    unwrapState(await this.state.unlockNamespaceLock(path, token));
  }

  async getCurrentCursor(): Promise<ChangeCursor> {
    return unwrapState(await this.state.getCurrentCursor()) as ChangeCursor;
  }

  async readChanges(
    after: ChangeCursor,
    options?: { limit?: number },
  ): Promise<ChangeFeedPage> {
    const page = unwrapState(
      await this.state.readChanges(after, options?.limit),
    );
    return {
      sets: page.sets.map((set) => ({
        cursor: set.cursor as ChangeCursor,
        changes: set.changes.map(toNodeChange),
      })),
      nextCursor: page.nextCursor as ChangeCursor,
      hasMore: page.hasMore,
    };
  }

  async getLock(
    nodeId: NodeId,
    owner: LockOwner,
    request: RecordLockQuery,
  ): Promise<LockConflict | undefined> {
    const conflict = unwrapState(
      await this.state.getLock(nodeId, owner, {
        type: request.type,
        range: toStoredRange(request.range),
      }),
    );
    return conflict
      ? {
          owner: conflict.owner,
          type: conflict.type,
          range: toLockRange(conflict.range),
        }
      : undefined;
  }

  async setLock(
    nodeId: NodeId,
    owner: LockOwner,
    request: RecordLockRequest,
    options?: { wait?: boolean },
  ): Promise<void> {
    unwrapState(
      await this.state.setLock(
        nodeId,
        owner,
        {
          type: request.type,
          range: toStoredRange(request.range),
        },
        options,
      ),
    );
  }

  async flock(
    nodeId: NodeId,
    owner: LockOwner,
    type: FlockType,
    options?: { wait?: boolean },
  ): Promise<void> {
    unwrapState(await this.state.flock(nodeId, owner, type, options));
  }

  async releaseOwner(owner: LockOwner): Promise<void> {
    unwrapState(await this.state.releaseOwner(owner));
  }

  async renewSession(sessionId: string): Promise<void> {
    unwrapState(await this.state.renewSession(sessionId));
  }
}

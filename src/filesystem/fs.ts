import type {
  CopyOptions,
  DirectoryEntry,
  FileContent,
  FileData,
  FileSystem,
  MoveOptions,
  ObjectStore,
  Path,
  ReadFileOptions,
  RemoveOptions,
  StorageQuota,
  StorageQuotaProvider,
  WriteFileOptions,
} from "../interfaces";
import { copy } from "./vfs/copy";
import { move } from "./vfs/move";
import { readFile, readdir, stat } from "./vfs/read";
import { remove } from "./vfs/remove";
import { mkdir, writeFile } from "./vfs/write";
import type { FileSystemState } from "./meta";
import { toResource } from "./vfs/helper";

export class ObjectStoreFileSystem implements FileSystem, StorageQuotaProvider {
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

  readFile(path: Path, options?: ReadFileOptions): Promise<FileContent> {
    return readFile(this.deps(), path, options);
  }

  readdir(path: Path): AsyncIterable<DirectoryEntry> {
    return readdir(this.deps(), path);
  }

  writeFile(path: Path, data: FileData, options?: WriteFileOptions) {
    return writeFile(this.deps(), path, data, options);
  }

  mkdir(path: Path) {
    return mkdir(this.deps(), path);
  }

  remove(path: Path, options?: RemoveOptions) {
    return remove(this.deps(), path, options);
  }

  async copy(source: Path, destination: Path, options: CopyOptions) {
    const resource = await copy(this.deps(), source, destination, options);
    return resource;
  }

  async move(source: Path, destination: Path, options: MoveOptions) {
    const resource = await move(this.deps(), source, destination, options);
    return resource;
  }

  async getQuota(path: Path): Promise<StorageQuota> {
    return { usedBytes: await this.state.usedBytes(path) };
  }

  async changesSince(path: Path, revision: number, level: "1" | "infinite") {
    const result = await this.state.changesSince(path, revision, level);
    if (!result.ok) throw new Error(result.error);
    return {
      revision: result.value.revision,
      changes: result.value.changes.map((change) =>
        change.kind === "changed"
          ? {
              kind: "changed" as const,
              path: change.path,
              resource: toResource(change.resource),
            }
          : { kind: "removed" as const, path: change.path },
      ),
    };
  }
}

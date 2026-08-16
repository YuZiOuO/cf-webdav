import type {
  CopyOptions,
  DirectoryEntry,
  FileContent,
  FileData,
  FileSystem,
  MoveOptions,
  Path,
  ReadFileOptions,
  RemoveOptions,
  StorageQuota,
  StorageQuotaProvider,
  WriteFileOptions,
} from "../interfaces/file_system";
import type { ObjectStore } from "../interfaces/object_store";
import { copy } from "./vfs/operations/copy";
import { move } from "./vfs/operations/move";
import { readFile, readdir, stat } from "./vfs/operations/read";
import { remove } from "./vfs/operations/remove";
import { mkdir, writeFile } from "./vfs/operations/write";
import type { FileSystemState } from "./meta";

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

  copy(source: Path, destination: Path, options: CopyOptions) {
    return copy(this.deps(), source, destination, options);
  }

  move(source: Path, destination: Path, options: MoveOptions) {
    return move(this.deps(), source, destination, options);
  }

  async getQuota(path: Path): Promise<StorageQuota> {
    return { usedBytes: await this.state.usedBytes(path) };
  }
}

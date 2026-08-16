import type {
  CopyOptions,
  FileData,
  FileSystem,
  MoveOptions,
  Path,
  ReadFileOptions,
  RemoveOptions,
  WriteFileOptions,
} from "../../interfaces";
import type { WebDavState } from "./state";

/** WebDAV's resource tree and the composition point for its metadata. */
export class DavTree implements FileSystem {
  constructor(
    private readonly filesystem: FileSystem,
    private readonly state: DurableObjectStub<WebDavState>,
  ) {}

  stat(path: Path) {
    return this.filesystem.stat(path);
  }
  readFile(path: Path, options?: ReadFileOptions) {
    return this.filesystem.readFile(path, options);
  }
  readdir(path: Path) {
    return this.filesystem.readdir(path);
  }
  writeFile(path: Path, data: FileData, options?: WriteFileOptions) {
    return this.filesystem.writeFile(path, data, options);
  }
  mkdir(path: Path) {
    return this.filesystem.mkdir(path);
  }

  async remove(path: Path, options?: RemoveOptions) {
    await this.filesystem.remove(path, options);
    await this.state.removeProperties(path, options?.recursive ?? false);
  }

  async copy(source: Path, destination: Path, options: CopyOptions) {
    const resource = await this.filesystem.copy(source, destination, options);
    await this.state.removeProperties(destination, options.overwrite);
    await this.state.copyProperties(source, destination, options.recursive);
    return resource;
  }

  async move(source: Path, destination: Path, options: MoveOptions) {
    const resource = await this.filesystem.move(source, destination, options);
    await this.state.removeProperties(destination, options.overwrite);
    await this.state.moveProperties(source, destination);
    return resource;
  }
}

import { dirname, join } from "node:path/posix";
import type { FileSystem, Node as FileSystemNode } from "../../interfaces";
import type {
  ByteRange,
  EntityTag,
  FileInfo,
  Path,
  ResourceInfo,
} from "./types";

export const toResourceInfo = (node: FileSystemNode): ResourceInfo =>
  node.kind === "file"
    ? {
        kind: "file",
        lastModified: node.lastModified,
        contentLength: node.size,
      }
    : {
        kind: "collection",
        lastModified: node.lastModified,
      };

export type ResourceFactory = (path: Path) => Resource;

/** A path-bound WebDAV resource. */
export class Resource {
  constructor(
    readonly path: Path,
    private readonly filesystem: FileSystem,
  ) {}

  resolve(path: Path) {
    return new Resource(path, this.filesystem);
  }

  parent(): Resource | undefined {
    if (this.path === "/") return undefined;
    return this.resolve(dirname(this.path) || "/");
  }

  async stat(): Promise<ResourceInfo | undefined> {
    const node = await this.node();
    return node ? toResourceInfo(node) : undefined;
  }

  async node(): Promise<FileSystemNode | undefined> {
    return this.filesystem.stat(this.path);
  }

  async etag(): Promise<EntityTag> {
    const node = await this.node();
    if (!node) throw new Error("Resource not found");
    return `"${node.id}-${node.lastModified.getTime()}"` as EntityTag;
  }

  async readFile(range?: ByteRange) {
    const {
      file,
      body,
      range: readRange,
    } = await this.filesystem.readFile(
      this.path,
      range ? { range } : undefined,
    );
    return {
      file: toResourceInfo(file) as FileInfo,
      body,
      ...(readRange ? { range: readRange } : {}),
    };
  }

  async *children(): AsyncIterable<{
    resource: Resource;
    info: ResourceInfo;
  }> {
    for await (const member of this.filesystem.readdir(this.path)) {
      yield {
        resource: this.resolve(join(this.path, member.name)),
        info: toResourceInfo(member.node),
      };
    }
  }

  async writeFile(body: ReadableStream<Uint8Array>): Promise<EntityTag> {
    const node = await this.filesystem.writeFile(this.path, body);
    return `"${node.id}-${node.lastModified.getTime()}"` as EntityTag;
  }

  async createCollection(): Promise<EntityTag> {
    const node = await this.filesystem.mkdir(this.path);
    return `"${node.id}-${node.lastModified.getTime()}"` as EntityTag;
  }

  async delete(): Promise<void> {
    await this.filesystem.remove(this.path, { recursive: true });
  }

  async copyTo(
    destination: Resource,
    options: { depth: "0" | "infinity"; overwrite: boolean },
  ): Promise<ResourceInfo> {
    const recursive = options.depth === "infinity";
    const resource = await this.filesystem.copy(this.path, destination.path, {
      recursive,
      overwrite: options.overwrite,
    });
    return toResourceInfo(resource);
  }

  async moveTo(
    destination: Resource,
    overwrite: boolean,
  ): Promise<ResourceInfo> {
    const resource = await this.filesystem.move(this.path, destination.path, {
      overwrite,
    });
    return toResourceInfo(resource);
  }
}

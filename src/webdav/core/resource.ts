import { dirname, join } from "node:path/posix";
import type { FileSystem, Resource as FileSystemResource } from "../../interfaces";
import type { WebDavState } from "./state";
import { newETag } from "./etag";
import type {
  ByteRange,
  EntityTag,
  FileInfo,
  FileData,
  Path,
  ResourceInfo,
} from "./types";

export const toResourceInfo = (resource: FileSystemResource): ResourceInfo =>
  resource.kind === "file"
    ? {
        kind: "file",
        lastModified: resource.lastModified,
        contentLength: resource.size,
        ...(resource.contentType ? { contentType: resource.contentType } : {}),
      }
    : {
        kind: "collection",
        lastModified: resource.lastModified,
      };

export type ResourceFactory = (path: Path) => Resource;

/** A path-bound WebDAV resource. */
export class Resource {
  constructor(
    readonly path: Path,
    private readonly filesystem: FileSystem,
    private readonly state: DurableObjectStub<WebDavState>,
  ) {}

  resolve(path: Path) {
    return new Resource(path, this.filesystem, this.state);
  }

  parent(): Resource | undefined {
    if (this.path === "/") return undefined;
    return this.resolve(dirname(this.path) || "/");
  }

  async stat(): Promise<ResourceInfo | undefined> {
    const resource = await this.filesystem.stat(this.path);
    return resource ? toResourceInfo(resource) : undefined;
  }

  async etag(): Promise<EntityTag> {
    const etags = await this.state.ensureETags([this.path]);
    return etags[this.path];
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
        info: toResourceInfo(member.resource),
      };
    }
  }

  async writeFile(data: FileData): Promise<EntityTag> {
    await this.filesystem.writeFile(this.path, {
      body: data.body,
      size: data.contentLength,
      ...(data.contentType ? { contentType: data.contentType } : {}),
    });
    const etag = newETag();
    await this.state.setETag(this.path, etag);
    return etag;
  }

  async createCollection(): Promise<EntityTag> {
    await this.filesystem.mkdir(this.path);
    const etag = newETag();
    await this.state.setETag(this.path, etag);
    return etag;
  }

  async delete(): Promise<void> {
    await this.filesystem.remove(this.path, { recursive: true });
    await this.state.removeProperties(this.path, true);
    await this.state.removeETags(this.path, true);
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
    await this.state.removeProperties(destination.path, options.overwrite);
    await this.state.removeETags(destination.path, options.overwrite);
    await this.state.copyProperties(this.path, destination.path, recursive);
    await this.state.setETag(destination.path, newETag());
    return toResourceInfo(resource);
  }

  async moveTo(
    destination: Resource,
    overwrite: boolean,
  ): Promise<ResourceInfo> {
    const resource = await this.filesystem.move(this.path, destination.path, {
      overwrite,
    });
    await this.state.removeProperties(destination.path, overwrite);
    await this.state.removeETags(destination.path, overwrite);
    await this.state.moveProperties(this.path, destination.path);
    await this.state.removeETags(this.path, true);
    await this.state.setETag(destination.path, newETag());
    return toResourceInfo(resource);
  }
}

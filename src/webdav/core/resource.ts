import { dirname, join } from "node:path/posix";
import type { FileSystem, Resource } from "../../interfaces";
import type { WebDavState } from "./state";
import { newETag } from "./etag";
import type {
  DavByteRange,
  EntityTag,
  DavFile,
  DavFileData,
  DavPath,
  DavResourceInfo,
} from "./types";

export const toDavResourceInfo = (resource: Resource): DavResourceInfo =>
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

export type DavResourceFactory = (path: DavPath) => DavResource;

/** A path-bound WebDAV resource. */
export class DavResource {
  constructor(
    readonly path: DavPath,
    private readonly filesystem: FileSystem,
    private readonly state: DurableObjectStub<WebDavState>,
  ) {}

  resolve(path: DavPath) {
    return new DavResource(path, this.filesystem, this.state);
  }

  parent(): DavResource | undefined {
    if (this.path === "/") return undefined;
    return this.resolve(dirname(this.path) || "/");
  }

  async stat(): Promise<DavResourceInfo | undefined> {
    const resource = await this.filesystem.stat(this.path);
    return resource ? toDavResourceInfo(resource) : undefined;
  }

  async etag(): Promise<EntityTag> {
    const etags = await this.state.ensureETags([this.path]);
    return etags[this.path];
  }

  async readFile(range?: DavByteRange) {
    const {
      file,
      body,
      range: readRange,
    } = await this.filesystem.readFile(
      this.path,
      range ? { range } : undefined,
    );
    return {
      file: toDavResourceInfo(file) as DavFile,
      body,
      ...(readRange ? { range: readRange } : {}),
    };
  }

  async *children(): AsyncIterable<{
    resource: DavResource;
    info: DavResourceInfo;
  }> {
    for await (const member of this.filesystem.readdir(this.path)) {
      yield {
        resource: this.resolve(join(this.path, member.name)),
        info: toDavResourceInfo(member.resource),
      };
    }
  }

  async writeFile(data: DavFileData): Promise<EntityTag> {
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
    destination: DavResource,
    options: { depth: "0" | "infinity"; overwrite: boolean },
  ): Promise<DavResourceInfo> {
    const recursive = options.depth === "infinity";
    const resource = await this.filesystem.copy(this.path, destination.path, {
      recursive,
      overwrite: options.overwrite,
    });
    await this.state.removeProperties(destination.path, options.overwrite);
    await this.state.removeETags(destination.path, options.overwrite);
    await this.state.copyProperties(this.path, destination.path, recursive);
    await this.state.setETag(destination.path, newETag());
    return toDavResourceInfo(resource);
  }

  async moveTo(
    destination: DavResource,
    overwrite: boolean,
  ): Promise<DavResourceInfo> {
    const resource = await this.filesystem.move(this.path, destination.path, {
      overwrite,
    });
    await this.state.removeProperties(destination.path, overwrite);
    await this.state.removeETags(destination.path, overwrite);
    await this.state.moveProperties(this.path, destination.path);
    await this.state.removeETags(this.path, true);
    await this.state.setETag(destination.path, newETag());
    return toDavResourceInfo(resource);
  }
}

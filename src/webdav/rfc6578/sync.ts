import type { FileSystem, Path, Resource } from "../../interfaces/file_system";
import type {
  SyncChange,
  SyncCollection,
  SyncRequest,
  SyncResult,
  SyncToken,
} from "../../interfaces/webdav/rfc6578";
import type { Path as DavPath } from "../../interfaces/file_system";
import type { DavPropertyExtension } from "../core/properties";
import {
  appendDavElement,
  createDavProperty,
  DAV_NAMESPACE,
} from "../core/xml";

const TOKEN_PREFIX = "urn:cf-webdav:sync:";

type FileSystemChange =
  | { kind: "changed"; path: Path; resource: Resource }
  | { kind: "removed"; path: Path };

type FileSystemChangeFeed = {
  changesSince(
    collection: Path,
    revision: number,
    level: "1" | "infinite",
  ): Promise<{ revision: number; changes: readonly FileSystemChange[] }>;
};

export class DavSync implements SyncCollection {
  constructor(
    private readonly filesystem: FileSystem,
    private readonly feed: FileSystemChangeFeed,
  ) {}

  async getSyncToken(collection: Path) {
    const result = await this.feed.changesSince(collection, 0, "infinite");
    return `${TOKEN_PREFIX}${result.revision}` as SyncToken;
  }

  private revision(token: SyncToken | undefined) {
    if (!token) return 0;
    if (!token.startsWith(TOKEN_PREFIX)) return undefined;
    const revision = Number(token.slice(TOKEN_PREFIX.length));
    return Number.isSafeInteger(revision) && revision >= 0
      ? revision
      : undefined;
  }

  private async current(collection: Path, level: "1" | "infinite") {
    const changes: SyncChange[] = [];
    const visit = async (path: Path, includeChildren: boolean) => {
      const resource = await this.filesystem.stat(path);
      if (!resource) return;
      changes.push({ kind: "changed", path, resource });
      if (resource.kind === "directory" && includeChildren) {
        for await (const entry of this.filesystem.readdir(path)) {
          const child = (
            path === "/" ? `/${entry.name}` : `${path}/${entry.name}`
          ) as Path;
          await visit(child, level === "infinite");
        }
      }
    };
    await visit(collection, true);
    return changes;
  }

  async sync(collection: Path, request: SyncRequest): Promise<SyncResult> {
    const revision = this.revision(request.syncToken);
    if (revision === undefined) return { error: "valid-sync-token" };

    let changes: readonly SyncChange[];
    let nextRevision: number;
    if (request.syncToken === undefined) {
      changes = await this.current(collection, request.syncLevel);
      nextRevision = (
        await this.feed.changesSince(collection, 0, request.syncLevel)
      ).revision;
    } else {
      const result = await this.feed.changesSince(
        collection,
        revision,
        request.syncLevel,
      );
      nextRevision = result.revision;
      changes = result.changes;
    }

    const syncToken = `${TOKEN_PREFIX}${nextRevision}` as SyncToken;
    if (request.limit !== undefined && changes.length > request.limit) {
      return {
        changes: changes.slice(0, request.limit),
        syncToken,
        truncated: true,
      };
    }
    return { changes, syncToken, truncated: false };
  }
}

export class DavSyncProperties implements DavPropertyExtension {
  constructor(private readonly sync: SyncCollection) {}

  async liveProperties(path: DavPath, resource: Resource) {
    if (resource.kind !== "directory") return [];
    const properties = [];
    const token = await this.sync.getSyncToken(path);
    if (token)
      properties.push({
        name: { namespaceURI: DAV_NAMESPACE, localName: "sync-token" },
        property: { element: createDavProperty("sync-token", token) },
      });
    const report = createDavProperty("supported-report-set");
    const supported = appendDavElement(report, "supported-report");
    const reportElement = appendDavElement(supported, "report");
    appendDavElement(reportElement, "sync-collection");
    properties.push({
      name: { namespaceURI: DAV_NAMESPACE, localName: "supported-report-set" },
      property: { element: report },
    });
    return properties;
  }

  isProtected(name: { namespaceURI: string; localName: string }) {
    return (
      name.namespaceURI === DAV_NAMESPACE &&
      (name.localName === "sync-token" ||
        name.localName === "supported-report-set")
    );
  }
}

import type { DavResource, DavResourceFactory } from "../core/resource";
import type { DavPath, DavResourceInfo } from "../core/types";
import type { DavLiveProperty } from "../rfc4918/properties";
import type { DavPropertyName } from "../rfc4918/types";
import {
  appendDavElement,
  createDavProperty,
  DAV_NAMESPACE,
} from "../core/xml";
import type {
  DavChangeFeed,
  SyncChange,
  SyncRequest,
  SyncResult,
  SyncToken,
} from "./types";

const TOKEN_PREFIX = "urn:cf-webdav:sync:";

export const syncProtectedPropertyNames: readonly DavPropertyName[] = [
  { namespaceURI: DAV_NAMESPACE, localName: "sync-token" },
  { namespaceURI: DAV_NAMESPACE, localName: "supported-report-set" },
];

export class DavSync {
  constructor(
    private readonly resource: DavResourceFactory,
    private readonly changes: DavChangeFeed,
  ) {}

  async getSyncToken(collection: DavPath) {
    const result = await this.changes(collection, 0, "infinite");
    return `${TOKEN_PREFIX}${result.revision}` as SyncToken;
  }

  async stateTokenMatches(collection: DavPath, token: string) {
    return token === (await this.getSyncToken(collection));
  }

  async liveProperties(
    resource: DavResource,
    info: DavResourceInfo,
  ): Promise<readonly DavLiveProperty[]> {
    if (info.kind !== "collection") return [];
    const properties: DavLiveProperty[] = [];
    const token = await this.getSyncToken(resource.path);
    if (token) {
      properties.push({
        name: { namespaceURI: DAV_NAMESPACE, localName: "sync-token" },
        property: { element: createDavProperty("sync-token", token) },
      });
    }
    const report = createDavProperty("supported-report-set");
    const supported = appendDavElement(report, "supported-report");
    const reportElement = appendDavElement(supported, "report");
    appendDavElement(reportElement, "sync-collection");
    properties.push({
      name: {
        namespaceURI: DAV_NAMESPACE,
        localName: "supported-report-set",
      },
      property: { element: report },
    });
    return properties;
  }

  async sync(collection: DavPath, request: SyncRequest): Promise<SyncResult> {
    const revision = (() => {
      if (request.syncToken === undefined) return 0;
      if (!request.syncToken.startsWith(TOKEN_PREFIX)) return undefined;
      const parsed = Number(request.syncToken.slice(TOKEN_PREFIX.length));
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
    })();
    if (revision === undefined) return { error: "valid-sync-token" };

    let changes: readonly SyncChange[];
    let nextRevision: number;
    if (request.syncToken === undefined) {
      const currentChanges: SyncChange[] = [];
      const visit = async (resource: DavResource, includeChildren: boolean) => {
        const info = await resource.stat();
        if (!info) return;
        currentChanges.push({
          kind: "changed",
          path: resource.path,
          resource: info,
        });
        if (info.kind === "collection" && includeChildren) {
          for await (const child of resource.children()) {
            await visit(child, request.syncLevel === "infinite");
          }
        }
      };
      await visit(this.resource(collection), true);
      changes = currentChanges;
      nextRevision = (await this.changes(collection, 0, request.syncLevel))
        .revision;
    } else {
      const result = await this.changes(
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

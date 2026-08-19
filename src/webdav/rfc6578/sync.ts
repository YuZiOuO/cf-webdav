import type { Resource, ResourceFactory } from "../core/resource";
import type { Path, ResourceInfo } from "../core/types";
import type { LiveProperty } from "../rfc4918/properties";
import type { PropertyName } from "../rfc4918/types";
import {
  appendDavElement,
  createDavProperty,
  DAV_NAMESPACE,
} from "../core/xml";
import type {
  ChangeFeed,
  RevisionProvider,
  SyncChange,
  SyncRequest,
  SyncResult,
  SyncToken,
} from "./types";

const TOKEN_PREFIX = "urn:cf-webdav:sync:";

export const syncProtectedPropertyNames: readonly PropertyName[] = [
  { namespaceURI: DAV_NAMESPACE, localName: "sync-token" },
  { namespaceURI: DAV_NAMESPACE, localName: "supported-report-set" },
];

export class Sync {
  constructor(
    private readonly resource: ResourceFactory,
    private readonly changes: ChangeFeed,
    private readonly revision: RevisionProvider,
  ) {}

  async getSyncToken(collection: Path) {
    const revision = await this.revision(collection);
    return `${TOKEN_PREFIX}${revision}` as SyncToken;
  }

  async stateTokenMatches(collection: Path, token: string) {
    return token === (await this.getSyncToken(collection));
  }

  async liveProperties(
    resource: Resource,
    info: ResourceInfo,
    syncToken?: SyncToken,
  ): Promise<readonly LiveProperty[]> {
    if (info.kind !== "collection") return [];
    const properties: LiveProperty[] = [];
    const token = syncToken ?? (await this.getSyncToken(resource.path));
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

  async sync(collection: Path, request: SyncRequest): Promise<SyncResult> {
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
      const visit = async (
        resource: Resource,
        info: ResourceInfo,
        includeChildren: boolean,
      ) => {
        currentChanges.push({
          kind: "changed",
          path: resource.path,
          resource: info,
        });
        if (info.kind === "collection" && includeChildren) {
          for await (const child of resource.children()) {
            await visit(
              child.resource,
              child.info,
              request.syncLevel === "infinite",
            );
          }
        }
      };
      const resource = this.resource(collection);
      const info = await resource.stat();
      if (info) await visit(resource, info, true);
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

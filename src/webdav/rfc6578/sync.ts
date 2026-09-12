import { dirname, relative } from "node:path/posix";
import type {
  ChangeCursor,
  ChangeFeedProvider,
  NodeChange,
} from "../../interfaces";
import type { Resource, ResourceFactory } from "../core/resource";
import type { Path, ResourceInfo } from "../core/types";
import type { LiveProperty } from "../rfc4918/properties";
import type { PropertyName } from "../rfc4918/types";
import {
  appendDavElement,
  createDavProperty,
  DAV_NAMESPACE,
} from "../core/xml";
import type { SyncChange, SyncRequest, SyncResult, SyncToken } from "./types";

const TOKEN_PREFIX = "urn:cf-webdav:sync:";

export const syncProtectedPropertyNames: readonly PropertyName[] = [
  { namespaceURI: DAV_NAMESPACE, localName: "sync-token" },
  { namespaceURI: DAV_NAMESPACE, localName: "supported-report-set" },
];

export class Sync {
  constructor(
    private readonly resource: ResourceFactory,
    private readonly changes: ChangeFeedProvider,
  ) {}

  async getSyncToken(collection: Path) {
    void collection;
    return `${TOKEN_PREFIX}${await this.changes.getCurrentCursor()}` as SyncToken;
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
    let changes: readonly SyncChange[];
    let nextCursor: ChangeCursor;
    if (request.syncToken === undefined) {
      nextCursor = await this.changes.getCurrentCursor();
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
    } else {
      const after = request.syncToken.startsWith(TOKEN_PREFIX)
        ? (request.syncToken.slice(TOKEN_PREFIX.length) as ChangeCursor)
        : undefined;
      if (!after) return { error: "valid-sync-token" };

      const latest = new Map<Path, "changed" | "removed">();
      const record = (path: Path, kind: "changed" | "removed") => {
        const descendant = relative(collection, path);
        const inScope =
          request.syncLevel === "1"
            ? dirname(path) === collection
            : descendant !== "" &&
              descendant !== ".." &&
              !descendant.startsWith("../");
        if (inScope) latest.set(path, kind);
      };
      const recordChange = (change: NodeChange) => {
        switch (change.kind) {
          case "created":
          case "modified":
            record(change.path, "changed");
            break;
          case "deleted":
            record(change.path, "removed");
            break;
          case "moved":
            record(change.previousPath, "removed");
            record(change.path, "changed");
            break;
        }
      };

      let cursor = after;
      for (;;) {
        const page = await this.changes.readChanges(cursor);
        for (const set of page.sets)
          for (const change of set.changes) recordChange(change);
        cursor = page.nextCursor;
        if (!page.hasMore) break;
      }
      nextCursor = cursor;
      changes = await Promise.all(
        [...latest.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(async ([path, kind]) => {
            if (kind === "removed") return { kind, path };
            const info = await this.resource(path).stat();
            return info
              ? { kind: "changed" as const, path, resource: info }
              : { kind: "removed" as const, path };
          }),
      );
    }

    const syncToken = `${TOKEN_PREFIX}${nextCursor}` as SyncToken;
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

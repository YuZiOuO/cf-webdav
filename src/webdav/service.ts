import {
  appendDavElement,
  createDavProperty,
  createPropertyElement,
  parseProperty,
  propertyChildren,
  propertyName,
  serializeProperty,
  supportedLockProperty,
  supportedReportSetProperty,
} from "./dav_xml";
import { resourceId, toResource } from "../filesystem/object_store_file_system";
import type { Directory, Path, Resource } from "../interfaces/file_system";
import type {
  DavPropfindRequest,
  DavProperty,
  DavPropertyName,
  DavPropertyService,
  DavPropStat,
  DavProppatchInstruction,
  Lock,
  LockManager,
  LockRequest,
  LockScope,
  LockToken,
} from "../interfaces/webdav/rfc4918";
import type {
  SyncChange,
  SyncCollection,
  SyncRequest,
  SyncResult,
  SyncToken,
} from "../interfaces/webdav/rfc6578";
import type { Quota, QuotaProvider } from "../interfaces/webdav/rfc4331";
import type {
  ExtendedMkcol,
  MkcolResponse,
} from "../interfaces/webdav/rfc5689";
import {
  newEntityTag,
  unwrapState,
  type FileSystemState,
  type StoredLock,
  type StoredProperty,
  type StoredProppatchInstruction,
} from "../filesystem/state";
import { name } from "../filesystem/path";

const DAV_NAMESPACE = "DAV:";

const propertyKey = ({ namespaceURI, localName }: DavPropertyName) =>
  `${namespaceURI}\0${localName}`;

const protectedPropertyNames = new Set(
  [
    "getetag",
    "getcontentlength",
    "getlastmodified",
    "resourcetype",
    "supportedlock",
    "sync-token",
    "supported-report-set",
    "quota-available-bytes",
    "quota-used-bytes",
  ].map((localName) => propertyKey({ namespaceURI: DAV_NAMESPACE, localName })),
);

const toLock = (lock: StoredLock): Lock => ({
  token: lock.token as LockToken,
  root: lock.root as Path,
  scope: lock.scope,
  depth: lock.depth,
  ...(lock.timeout === undefined ? {} : { timeout: lock.timeout }),
  ...(lock.owner ? { owner: parseProperty(lock.owner).element } : {}),
});

const storedProperty = (property: DavProperty): StoredProperty => {
  const { namespaceURI, localName } = propertyName(property.element);
  return {
    namespaceURI,
    localName,
    xml: serializeProperty(property),
  };
};

const instructionProperty = (
  instruction: DavProppatchInstruction,
): DavProperty =>
  instruction.kind === "set"
    ? instruction.property
    : { element: createPropertyElement(instruction.name) };

const isProtectedInstruction = (instruction: DavProppatchInstruction) =>
  protectedPropertyNames.has(
    propertyKey(
      instruction.kind === "set"
        ? propertyName(instruction.property.element)
        : instruction.name,
    ),
  );

export class WebDav
  implements
    DavPropertyService,
    LockManager,
    SyncCollection,
    ExtendedMkcol,
    QuotaProvider
{
  constructor(private readonly state: DurableObjectStub<FileSystemState>) {}

  private async liveProperties(
    path: Path,
    resource: Resource,
  ): Promise<readonly { name: DavPropertyName; property: DavProperty }[]> {
    const properties: { name: DavPropertyName; property: DavProperty }[] = [];
    const dav = (localName: string, property: DavProperty) =>
      properties.push({
        name: { namespaceURI: DAV_NAMESPACE, localName },
        property,
      });

    dav("displayname", {
      element: createDavProperty(
        "displayname",
        path === "/" ? "/" : name(path),
      ),
    });
    dav("getlastmodified", {
      element: createDavProperty(
        "getlastmodified",
        resource.lastModified.toUTCString(),
      ),
    });
    dav("getetag", { element: createDavProperty("getetag", resource.etag) });

    const resourceType = createDavProperty("resourcetype");
    if (resource.kind === "directory")
      appendDavElement(resourceType, "collection");
    dav("resourcetype", { element: resourceType });
    dav("supportedlock", supportedLockProperty(["exclusive", "shared"]));

    if (resource.kind === "file") {
      dav("getcontentlength", {
        element: createDavProperty("getcontentlength", String(resource.size)),
      });
      if (resource.contentType)
        dav("getcontenttype", {
          element: createDavProperty("getcontenttype", resource.contentType),
        });
    } else {
      const token = await this.getSyncToken(path);
      if (token)
        dav("sync-token", { element: createDavProperty("sync-token", token) });
      dav("supported-report-set", supportedReportSetProperty());
    }
    return properties;
  }

  async propfind(
    path: Path,
    resource: Resource,
    request: DavPropfindRequest,
  ): Promise<readonly DavPropStat[]> {
    const available = [...(await this.liveProperties(path, resource))];
    for (const stored of await this.state.getProperties(path)) {
      const property = parseProperty(stored.xml);
      available.push({ name: propertyName(property.element), property });
    }

    if (request.kind === "propname") {
      return [
        {
          properties: available.map(({ name }) => ({
            element: createPropertyElement(name),
          })),
          status: 200,
        },
      ];
    }

    const requested =
      request.kind === "prop"
        ? request.names
        : available.map(({ name }) => name).concat(request.include ?? []);

    const found: DavProperty[] = [];
    const missing: DavProperty[] = [];
    for (const requestedName of requested) {
      const match = available.find(
        ({ name }) => propertyKey(name) === propertyKey(requestedName),
      );
      (match ? found : missing).push(
        match?.property ?? { element: createPropertyElement(requestedName) },
      );
    }
    return [
      ...(found.length ? [{ properties: found, status: 200 }] : []),
      ...(missing.length ? [{ properties: missing, status: 404 }] : []),
    ];
  }

  async proppatch(
    path: Path,
    _resource: Resource,
    instructions: readonly DavProppatchInstruction[],
  ): Promise<readonly DavPropStat[]> {
    if (instructions.some(isProtectedInstruction)) {
      return instructions.map((instruction) => ({
        properties: [instructionProperty(instruction)],
        status: isProtectedInstruction(instruction) ? 403 : 424,
      }));
    }

    const stored: StoredProppatchInstruction[] = instructions.map(
      (instruction) =>
        instruction.kind === "set"
          ? { kind: "set", property: storedProperty(instruction.property) }
          : { kind: "remove", name: instruction.name },
    );
    unwrapState(await this.state.patchProperties(path, stored));
    return instructions.map((instruction) => ({
      properties: [instructionProperty(instruction)],
      status: 200,
    }));
  }

  getSupportedLockScopes(): Promise<readonly LockScope[]> {
    return Promise.resolve(["exclusive", "shared"]);
  }

  async getLocks(path: Path) {
    return (await this.state.getLocks(path)).map(toLock);
  }

  async lock(path: Path, request: LockRequest) {
    return toLock(
      unwrapState(
        await this.state.createLock(path, {
          scope: request.scope,
          depth: request.depth,
          ...(request.timeout === undefined || request.timeout === "infinite"
            ? {}
            : { timeout: request.timeout }),
          ...(request.owner
            ? { owner: serializeProperty({ element: request.owner }) }
            : {}),
        }),
      ),
    );
  }

  async refresh(path: Path, token: LockToken, timeout?: Lock["timeout"]) {
    return toLock(
      unwrapState(
        await this.state.refreshLock(
          path,
          token,
          timeout === undefined || timeout === "infinite" ? undefined : timeout,
        ),
      ),
    );
  }

  async unlock(path: Path, token: LockToken) {
    unwrapState(await this.state.unlock(path, token));
  }

  async getSyncToken(collection: Path) {
    const token = await this.state.getSyncToken(collection);
    return token ? (token as SyncToken) : undefined;
  }

  async sync(collection: Path, request: SyncRequest): Promise<SyncResult> {
    const stored = unwrapState(
      await this.state.sync(collection, request.syncToken, request.syncLevel),
    );
    const changes: SyncChange[] = stored.changes.map((change) =>
      change.kind === "changed"
        ? {
            kind: "changed",
            path: change.path as Path,
            resource: toResource(change.resource),
          }
        : { kind: "removed", path: change.path as Path },
    );
    if (request.limit !== undefined && changes.length > request.limit) {
      return {
        changes: changes.slice(0, request.limit),
        syncToken: stored.token as SyncToken,
        truncated: true,
      };
    }
    return {
      changes,
      syncToken: stored.token as SyncToken,
      truncated: false,
    };
  }

  async mkcol(
    path: Path,
    properties: readonly DavProperty[],
  ): Promise<Directory | MkcolResponse> {
    if (
      properties.some((property) => {
        const { namespaceURI, localName } = propertyName(property.element);
        return (
          namespaceURI === DAV_NAMESPACE &&
          localName === "resourcetype" &&
          propertyChildren(property).some(
            (child) =>
              child.namespaceURI !== DAV_NAMESPACE ||
              child.localName !== "collection",
          )
        );
      })
    ) {
      return {
        propstats: properties.map((property) => ({
          properties: [property],
          status: 403,
        })),
      };
    }

    const deadProperties = properties
      .filter(
        (property) =>
          !protectedPropertyNames.has(
            propertyKey(propertyName(property.element)),
          ),
      )
      .map(storedProperty);
    return toResource(
      unwrapState(
        await this.state.createDirectoryWithProperties(
          path,
          { id: resourceId(), etag: newEntityTag() },
          deadProperties,
        ),
      ),
    ) as Directory;
  }

  getQuota(): Promise<Quota | undefined> {
    return Promise.resolve(undefined);
  }
}

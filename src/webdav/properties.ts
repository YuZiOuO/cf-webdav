import type { Path, Resource } from "../interfaces/file_system";
import type { QuotaProvider } from "../interfaces/webdav/rfc4331";
import type {
  DavPropfindRequest,
  DavProperty,
  DavPropertyName,
  DavPropertyService,
  DavPropStat,
  DavProppatchInstruction,
  LockManager,
} from "../interfaces/webdav/rfc4918";
import type { SyncCollection } from "../interfaces/webdav/rfc6578";
import { name } from "../filesystem/vfs/path";
import type {
  FileSystemState,
  StoredProppatchInstruction,
} from "../filesystem/meta";
import {
  appendDavElement,
  createDavProperty,
  createPropertyElement,
  parseProperty,
  propertyName,
  DAV_NAMESPACE,
  supportedLockProperty,
  supportedReportSetProperty,
} from "./xml";
import {
  instructionProperty,
  isProtectedInstruction,
  propertyKey,
  storedProperty,
} from "./property";
import { unwrapState } from "../filesystem/meta/helper";

export class DavProperties implements DavPropertyService {
  constructor(
    private readonly state: DurableObjectStub<FileSystemState>,
    private readonly locks: LockManager,
    private readonly sync: SyncCollection,
    private readonly quota: QuotaProvider,
  ) {}

  private async liveProperties(
    path: Path,
    resource: Resource,
    includeQuota: boolean,
  ): Promise<readonly { name: DavPropertyName; property: DavProperty }[]> {
    const properties: { name: DavPropertyName; property: DavProperty }[] = [];
    const add = (localName: string, property: DavProperty) =>
      properties.push({
        name: { namespaceURI: DAV_NAMESPACE, localName },
        property,
      });

    add("displayname", {
      element: createDavProperty(
        "displayname",
        path === "/" ? "/" : name(path),
      ),
    });
    add("getlastmodified", {
      element: createDavProperty(
        "getlastmodified",
        resource.lastModified.toUTCString(),
      ),
    });
    add("getetag", { element: createDavProperty("getetag", resource.etag) });

    const resourceType = createDavProperty("resourcetype");
    if (resource.kind === "directory")
      appendDavElement(resourceType, "collection");
    add("resourcetype", { element: resourceType });
    add(
      "supportedlock",
      supportedLockProperty(await this.locks.getSupportedLockScopes(path)),
    );

    if (resource.kind === "file") {
      add("getcontentlength", {
        element: createDavProperty("getcontentlength", String(resource.size)),
      });
      if (resource.contentType)
        add("getcontenttype", {
          element: createDavProperty("getcontenttype", resource.contentType),
        });
    } else {
      const token = await this.sync.getSyncToken(path);
      if (token)
        add("sync-token", {
          element: createDavProperty("sync-token", token),
        });
      add("supported-report-set", supportedReportSetProperty());
      if (includeQuota) {
        const quota = await this.quota.getQuota(path);
        if (quota) {
          add("quota-available-bytes", {
            element: createDavProperty(
              "quota-available-bytes",
              String(quota.availableBytes),
            ),
          });
          add("quota-used-bytes", {
            element: createDavProperty(
              "quota-used-bytes",
              String(quota.usedBytes),
            ),
          });
        }
      }
    }
    return properties;
  }

  async propfind(
    path: Path,
    resource: Resource,
    request: DavPropfindRequest,
  ): Promise<readonly DavPropStat[]> {
    const available = [
      ...(await this.liveProperties(
        path,
        resource,
        request.kind !== "allprop",
      )),
    ];
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
}

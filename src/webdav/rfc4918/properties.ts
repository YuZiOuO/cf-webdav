import { basename } from "node:path/posix";
import type { DavResource } from "../core/resource";
import type { DavResourceInfo } from "../core/types";
import type { WebDavState } from "../core/state";
import type { DavLocks } from "./locks";
import type {
  DavPropfindRequest,
  DavProperty,
  DavPropertyName,
  DavPropStat,
  DavProppatchInstruction,
} from "./types";
import { newETag } from "./http";
import {
  appendDavElement,
  createDavProperty,
  createPropertyElement,
  parseProperty,
  propertyName,
  serializeProperty,
  DAV_NAMESPACE,
} from "../core/xml";

export interface DavLiveProperty {
  name: DavPropertyName;
  property: DavProperty;
}

export const propertyKey = ({ namespaceURI, localName }: DavPropertyName) =>
  `${namespaceURI}\0${localName}`;

export const protectedPropertyNames = new Set(
  [
    "getetag",
    "getcontentlength",
    "getlastmodified",
    "resourcetype",
    "supportedlock",
  ].map((localName) => propertyKey({ namespaceURI: DAV_NAMESPACE, localName })),
);

const instructionProperty = (instruction: DavProppatchInstruction) =>
  instruction.kind === "set"
    ? instruction.property
    : { element: createPropertyElement(instruction.name) };

export class DavProperties {
  constructor(
    private readonly state: DurableObjectStub<WebDavState>,
    private readonly locks: DavLocks,
    private readonly extraProtected: readonly DavPropertyName[] = [],
  ) {}

  private async coreLiveProperties(
    resource: DavResource,
    info: DavResourceInfo,
  ): Promise<DavLiveProperty[]> {
    const properties: DavLiveProperty[] = [];
    const add = (localName: string, property: DavProperty) =>
      properties.push({
        name: { namespaceURI: DAV_NAMESPACE, localName },
        property,
      });

    add("displayname", {
      element: createDavProperty(
        "displayname",
        resource.path === "/" ? "/" : basename(resource.path),
      ),
    });
    add("getlastmodified", {
      element: createDavProperty(
        "getlastmodified",
        info.lastModified.toUTCString(),
      ),
    });
    const etag = await this.state.ensureETag(resource.path, newETag);
    add("getetag", { element: createDavProperty("getetag", etag) });

    const resourceType = createDavProperty("resourcetype");
    if (info.kind === "collection")
      appendDavElement(resourceType, "collection");
    add("resourcetype", { element: resourceType });
    const supportedLock = createDavProperty("supportedlock");
    for (const scope of await this.locks.getSupportedLockScopes()) {
      const entry = appendDavElement(supportedLock, "lockentry");
      const scopeElement = appendDavElement(entry, "lockscope");
      appendDavElement(scopeElement, scope);
      const typeElement = appendDavElement(entry, "locktype");
      appendDavElement(typeElement, "write");
    }
    add("supportedlock", { element: supportedLock });

    if (info.kind === "file") {
      add("getcontentlength", {
        element: createDavProperty(
          "getcontentlength",
          String(info.contentLength),
        ),
      });
      if (info.contentType)
        add("getcontenttype", {
          element: createDavProperty("getcontenttype", info.contentType),
        });
    }
    return properties;
  }

  isProtectedName(name: DavPropertyName) {
    return (
      protectedPropertyNames.has(propertyKey(name)) ||
      this.extraProtected.some(
        (candidate) => propertyKey(candidate) === propertyKey(name),
      )
    );
  }

  async propfind(
    resource: DavResource,
    info: DavResourceInfo,
    request: DavPropfindRequest,
    extraLive: readonly DavLiveProperty[] = [],
  ): Promise<readonly DavPropStat[]> {
    const available = [
      ...(await this.coreLiveProperties(resource, info)),
      ...extraLive,
    ];
    for (const stored of await this.state.getProperties(resource.path)) {
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
    resource: DavResource,
    instructions: readonly DavProppatchInstruction[],
  ): Promise<readonly DavPropStat[]> {
    const isProtected = (instruction: DavProppatchInstruction) => {
      const name =
        instruction.kind === "set"
          ? propertyName(instruction.property.element)
          : instruction.name;
      return (
        protectedPropertyNames.has(propertyKey(name)) ||
        this.extraProtected.some(
          (candidate) => propertyKey(candidate) === propertyKey(name),
        )
      );
    };
    if (instructions.some(isProtected)) {
      return instructions.map((instruction) => ({
        properties: [instructionProperty(instruction)],
        status: isProtected(instruction) ? 403 : 424,
      }));
    }

    const stored: Parameters<WebDavState["patchProperties"]>[1] =
      instructions.map((instruction) => {
        if (instruction.kind !== "set")
          return { kind: "remove" as const, name: instruction.name };
        const { namespaceURI, localName } = propertyName(
          instruction.property.element,
        );
        return {
          kind: "set" as const,
          property: {
            namespaceURI,
            localName,
            xml: serializeProperty(instruction.property),
          },
        };
      });
    const result = await this.state.patchProperties(resource.path, stored);
    if (!result.ok) throw new Error(result.error);
    return instructions.map((instruction) => ({
      properties: [instructionProperty(instruction)],
      status: 200,
    }));
  }
}

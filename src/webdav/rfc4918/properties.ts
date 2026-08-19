import { basename } from "node:path/posix";
import type { DavResource } from "../core/resource";
import type { DavResourceInfo } from "../core/types";
import { unwrapState, type WebDavState } from "../core/state";
import type { DavLocks } from "./locks";
import type {
  DavPropfindRequest,
  DavProperty,
  DavPropertyName,
  DavPropStat,
  DavProppatchInstruction,
} from "./types";
import type { EntityTag } from "./http";
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

interface DavPropfindItem {
  resource: DavResource;
  info: DavResourceInfo;
  extraLive?: readonly DavLiveProperty[];
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
    etag: "fetch" | "name-only" | "omit",
    etags: Record<string, EntityTag>,
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
    switch (etag) {
      case "fetch": {
        const value = etags[resource.path];
        add("getetag", { element: createDavProperty("getetag", value) });
        break;
      }
      case "name-only":
        add("getetag", { element: createDavProperty("getetag", "") });
        break;
      case "omit":
        break;
    }

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
    items: readonly DavPropfindItem[],
    request: DavPropfindRequest,
  ): Promise<readonly (readonly DavPropStat[])[]> {
    const paths = items.map(({ resource }) => resource.path);
    const [etags, storedProperties] = await Promise.all([
      this.state.ensureETags(paths),
      this.state.getPropertiesForPaths(paths),
    ]);

    let etagMode: "fetch" | "name-only" | "omit";
    switch (request.kind) {
      case "propname":
        etagMode = "name-only";
        break;
      case "allprop":
        etagMode = "fetch";
        break;
      case "prop":
        etagMode = request.names.some(
          (name) =>
            propertyKey(name) ===
            propertyKey({
              namespaceURI: DAV_NAMESPACE,
              localName: "getetag",
            }),
        )
          ? "fetch"
          : "omit";
        break;
    }

    const propfindItem = async ({
      resource,
      info,
      extraLive = [],
    }: DavPropfindItem): Promise<readonly DavPropStat[]> => {
      const available = [
        ...(await this.coreLiveProperties(resource, info, etagMode, etags)),
        ...extraLive,
      ];
      for (const stored of storedProperties[resource.path] ?? []) {
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
    };

    return Promise.all(items.map(propfindItem));
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
    unwrapState(await this.state.patchProperties(resource.path, stored));
    return instructions.map((instruction) => ({
      properties: [instructionProperty(instruction)],
      status: 200,
    }));
  }
}

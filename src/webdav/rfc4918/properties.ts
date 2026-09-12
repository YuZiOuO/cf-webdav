import { basename } from "node:path/posix";
import type { XAttrProvider } from "../../interfaces";
import { FileSystemError } from "../../filesystem";
import type { Resource } from "../core/resource";
import type { ResourceInfo } from "../core/types";
import type {
  PropfindRequest,
  Property,
  PropertyName,
  PropStat,
  ProppatchInstruction,
} from "./types";
import type { EntityTag } from "../core/types";
import {
  appendDavElement,
  createDavProperty,
  createPropertyElement,
  parseProperty,
  propertyName,
  serializeProperty,
  DAV_NAMESPACE,
} from "../core/xml";

export interface LiveProperty {
  name: PropertyName;
  property: Property;
}

interface PropfindItem {
  resource: Resource;
  info: ResourceInfo;
  extraLive?: readonly LiveProperty[];
}

interface StoredProperty {
  namespaceURI: string;
  localName: string;
  xml: string;
}

export const propertyKey = ({ namespaceURI, localName }: PropertyName) =>
  `${namespaceURI}\0${localName}`;

const XATTR_PREFIX = "user.webdav.property.";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const propertyXattrName = ({ namespaceURI, localName }: PropertyName) =>
  `${XATTR_PREFIX}${encodeURIComponent(namespaceURI)}:${encodeURIComponent(localName)}`;

const propertyNameFromXattr = (name: string): PropertyName | undefined => {
  if (!name.startsWith(XATTR_PREFIX)) return undefined;
  const encoded = name.slice(XATTR_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator < 0) return undefined;
  try {
    return {
      namespaceURI: decodeURIComponent(encoded.slice(0, separator)),
      localName: decodeURIComponent(encoded.slice(separator + 1)),
    };
  } catch {
    return undefined;
  }
};

const protectedPropertyNames = new Set(
  [
    "getetag",
    "getcontentlength",
    "getlastmodified",
    "resourcetype",
    "supportedlock",
  ].map((localName) => propertyKey({ namespaceURI: DAV_NAMESPACE, localName })),
);

const instructionProperty = (instruction: ProppatchInstruction) =>
  instruction.kind === "set"
    ? instruction.property
    : { element: createPropertyElement(instruction.name) };

export class Properties {
  constructor(
    private readonly xattrs: XAttrProvider,
    private readonly extraProtected: readonly PropertyName[] = [],
  ) {}

  private async storedProperties(
    items: readonly PropfindItem[],
  ): Promise<Record<string, readonly StoredProperty[]>> {
    const stored: Record<string, readonly StoredProperty[]> = {};
    await Promise.all(
      items.map(async ({ resource }) => {
        const node = await resource.node();
        if (!node) {
          stored[resource.path] = [];
          return;
        }
        const names = (await this.xattrs.listXattrs(node.id))
          .map((name) => ({ name, property: propertyNameFromXattr(name) }))
          .filter(
            (entry): entry is { name: string; property: PropertyName } =>
              entry.property !== undefined,
          );
        const properties = await Promise.all(
          names.map(async ({ name, property }) => {
            const value = await this.xattrs.getXattr(node.id, name);
            return value
              ? { ...property, xml: decoder.decode(value) }
              : undefined;
          }),
        );
        stored[resource.path] = properties.filter(
          (value): value is StoredProperty => value !== undefined,
        );
      }),
    );
    return stored;
  }

  private coreLiveProperties(
    resource: Resource,
    info: ResourceInfo,
    etag: "fetch" | "name-only" | "omit",
    etags: Record<string, EntityTag>,
  ): LiveProperty[] {
    const properties: LiveProperty[] = [];
    const add = (localName: string, property: Property) =>
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
    for (const scope of ["exclusive", "shared"] as const) {
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
    }
    return properties;
  }

  isProtectedName(name: PropertyName) {
    return (
      protectedPropertyNames.has(propertyKey(name)) ||
      this.extraProtected.some(
        (candidate) => propertyKey(candidate) === propertyKey(name),
      )
    );
  }

  async propfind(
    items: readonly PropfindItem[],
    request: PropfindRequest,
  ): Promise<readonly (readonly PropStat[])[]> {
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
    const etags: Record<string, EntityTag> = {};
    const [, storedProperties] = await Promise.all([
      etagMode === "fetch"
        ? Promise.all(
            items.map(async ({ resource }) => {
              etags[resource.path] = await resource.etag();
            }),
          )
        : Promise.resolve(),
      this.storedProperties(items),
    ]);

    const propfindItem = ({
      resource,
      info,
      extraLive = [],
    }: PropfindItem): readonly PropStat[] => {
      const available = [
        ...this.coreLiveProperties(resource, info, etagMode, etags),
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

      const found: Property[] = [];
      const missing: Property[] = [];
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

    return items.map(propfindItem);
  }

  async proppatch(
    resource: Resource,
    instructions: readonly ProppatchInstruction[],
  ): Promise<readonly PropStat[]> {
    const isProtected = (instruction: ProppatchInstruction) => {
      const name =
        instruction.kind === "set"
          ? propertyName(instruction.property.element)
          : instruction.name;
      return this.isProtectedName(name);
    };
    if (instructions.some(isProtected)) {
      return instructions.map((instruction) => ({
        properties: [instructionProperty(instruction)],
        status: isProtected(instruction) ? 403 : 424,
      }));
    }

    const node = await resource.node();
    if (!node) throw new FileSystemError("not-found", "Resource not found");
    const changes = instructions.map((instruction) => {
      if (instruction.kind !== "set")
        return {
          kind: "remove" as const,
          name: propertyXattrName(instruction.name),
        };
      const name = propertyName(instruction.property.element);
      return {
        kind: "set" as const,
        name: propertyXattrName(name),
        value: encoder.encode(serializeProperty(instruction.property)),
      };
    });
    await this.xattrs.patchXattrs(node.id, changes);
    return instructions.map((instruction) => ({
      properties: [instructionProperty(instruction)],
      status: 200,
    }));
  }
}

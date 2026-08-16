import type { Path, Resource } from "../../interfaces/file_system";
import type {
  DavPropfindRequest,
  DavProperty,
  DavPropertyName,
  DavPropertyService,
  DavPropStat,
  DavProppatchInstruction,
  LockManager,
  LockScope,
} from "../../interfaces/webdav/rfc4918";
import { name } from "../../filesystem/vfs/path";
import type { WebDavState } from "./state";
import {
  appendDavElement,
  createDavProperty,
  createPropertyElement,
  parseProperty,
  propertyName,
  serializeProperty,
  DAV_NAMESPACE,
} from "./xml";

const supportedLockProperty = (scopes: readonly LockScope[]): DavProperty => {
  const property = createDavProperty("supportedlock");
  for (const scope of scopes) {
    const entry = appendDavElement(property, "lockentry");
    const scopeElement = appendDavElement(entry, "lockscope");
    appendDavElement(scopeElement, scope);
    const typeElement = appendDavElement(entry, "locktype");
    appendDavElement(typeElement, "write");
  }
  return { element: property };
};

export interface DavPropertyExtension {
  liveProperties(
    path: Path,
    resource: Resource,
    include: boolean,
  ): Promise<readonly { name: DavPropertyName; property: DavProperty }[]>;
  isProtected(name: DavPropertyName): boolean;
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

export const storedProperty = (property: DavProperty) => {
  const { namespaceURI, localName } = propertyName(property.element);
  return { namespaceURI, localName, xml: serializeProperty(property) };
};

export const instructionProperty = (instruction: DavProppatchInstruction) =>
  instruction.kind === "set"
    ? instruction.property
    : { element: createPropertyElement(instruction.name) };

export const isProtectedInstruction = (instruction: DavProppatchInstruction) =>
  protectedPropertyNames.has(
    propertyKey(
      instruction.kind === "set"
        ? propertyName(instruction.property.element)
        : instruction.name,
    ),
  );

export class DavProperties implements DavPropertyService {
  constructor(
    private readonly state: DurableObjectStub<WebDavState>,
    private readonly locks: LockManager,
    private readonly extensions: readonly DavPropertyExtension[] = [],
  ) {}

  private async liveProperties(
    path: Path,
    resource: Resource,
    include: boolean,
  ) {
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
    }
    for (const extension of this.extensions)
      properties.push(
        ...(await extension.liveProperties(path, resource, include)),
      );
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
    const isProtected = (instruction: DavProppatchInstruction) =>
      isProtectedInstruction(instruction) ||
      this.extensions.some((extension) =>
        extension.isProtected(
          instruction.kind === "set"
            ? propertyName(instruction.property.element)
            : instruction.name,
        ),
      );
    if (instructions.some(isProtected)) {
      return instructions.map((instruction) => ({
        properties: [instructionProperty(instruction)],
        status: isProtected(instruction) ? 403 : 424,
      }));
    }

    const stored: Parameters<WebDavState["patchProperties"]>[1] =
      instructions.map((instruction) =>
        instruction.kind === "set"
          ? {
              kind: "set" as const,
              property: storedProperty(instruction.property),
            }
          : { kind: "remove" as const, name: instruction.name },
      );
    const result = await this.state.patchProperties(path, stored);
    if (!result.ok) throw new Error(result.error);
    return instructions.map((instruction) => ({
      properties: [instructionProperty(instruction)],
      status: 200,
    }));
  }
}

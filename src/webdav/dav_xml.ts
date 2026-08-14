import {
  DOMImplementation,
  DOMParser,
  XMLSerializer,
  type Element as XmlElement,
} from "@xmldom/xmldom";
import { XMLValidator } from "fast-xml-parser";
import type {
  DavProperty,
  DavPropertyName,
  DavPropfindRequest,
  DavProppatchInstruction,
  DavPropStat,
  Lock,
  LockScope,
} from "../interfaces/webdav/rfc4918";

const DAV_NAMESPACE = "DAV:";

type DavElement = Element;

const serializer = new XMLSerializer();

const xmlElement = (element: DavElement) => element as unknown as XmlElement;

const davElement = (element: XmlElement) => element as unknown as DavElement;

const children = (parent: XmlElement) =>
  Array.from(parent.childNodes).filter(
    (node): node is XmlElement => node.nodeType === 1,
  );

const localName = (element: XmlElement) =>
  element.localName ?? element.nodeName.split(":").pop()!;

const child = (parent: XmlElement, namespace: string, name: string) =>
  children(parent).find(
    (element) =>
      element.namespaceURI === namespace && localName(element) === name,
  );

const documentRoot = (name: string) => {
  const document = new DOMImplementation().createDocument(
    DAV_NAMESPACE,
    `D:${name}`,
    null,
  );
  const root = document.documentElement!;
  return { document, root };
};

const parseRoot = (xml: string) => {
  const root = new DOMParser().parseFromString(
    xml,
    "application/xml",
  ).documentElement;
  if (!root || localName(root) === "parsererror")
    throw new Error("Invalid XML document");
  return root;
};

const statusText: Record<number, string> = {
  200: "OK",
  403: "Forbidden",
  404: "Not Found",
  424: "Failed Dependency",
};

const appendStatus = (parent: XmlElement, status: number) =>
  appendDavElement(
    davElement(parent),
    "status",
    `HTTP/1.1 ${status} ${statusText[status] ?? ""}`.trim(),
  );

const appendPropstat = (parent: XmlElement, propstat: DavPropStat) => {
  const propstatElement = xmlElement(
    appendDavElement(davElement(parent), "propstat"),
  );
  const properties = xmlElement(
    appendDavElement(davElement(propstatElement), "prop"),
  );
  for (const property of propstat.properties)
    properties.appendChild(
      parent.ownerDocument!.importNode(xmlElement(property.element), true),
    );
  appendStatus(propstatElement, propstat.status);
};

const propertyElement = (name: DavPropertyName) => {
  const prefix = name.namespaceURI === DAV_NAMESPACE ? "D" : "P";
  const document = new DOMImplementation().createDocument(
    name.namespaceURI || null,
    name.namespaceURI ? `${prefix}:${name.localName}` : name.localName,
    null,
  );
  const root = document.documentElement!;
  return root;
};

const appendActiveLock = (parent: XmlElement, lock: Lock) => {
  const active = xmlElement(appendDavElement(davElement(parent), "activelock"));
  const scope = xmlElement(appendDavElement(davElement(active), "lockscope"));
  appendDavElement(davElement(scope), lock.scope);
  const type = xmlElement(appendDavElement(davElement(active), "locktype"));
  appendDavElement(davElement(type), "write");
  appendDavElement(davElement(active), "depth", lock.depth);
  appendDavElement(
    davElement(active),
    "timeout",
    lock.timeout === undefined || lock.timeout === "infinite"
      ? "Infinite"
      : `Second-${lock.timeout}`,
  );
  if (lock.owner)
    active.appendChild(
      active.ownerDocument!.importNode(xmlElement(lock.owner), true),
    );
  const token = xmlElement(appendDavElement(davElement(active), "locktoken"));
  appendDavElement(davElement(token), "href", lock.token);
};

export const isValidXml = (xml: string) =>
  !/\bxmlns:[\w.-]+\s*=\s*(["'])\s*\1/.test(xml) &&
  XMLValidator.validate(xml) === true;

export const appendDavElement = (
  parent: DavElement,
  name: string,
  value?: string,
) => {
  const xmlParent = xmlElement(parent);
  const document = xmlParent.ownerDocument!;
  const element = document.createElementNS(DAV_NAMESPACE, `D:${name}`);
  if (value !== undefined) element.appendChild(document.createTextNode(value));
  xmlParent.appendChild(element);
  return davElement(element);
};

export const propertyName = (element: DavElement): DavPropertyName => {
  const value = xmlElement(element);
  return {
    namespaceURI: value.namespaceURI ?? "",
    localName: localName(value),
  };
};

export const propertyChildren = (property: DavProperty) =>
  children(xmlElement(property.element)).map((element) => ({
    namespaceURI: element.namespaceURI,
    localName: localName(element),
  }));

export const createPropertyElement = (name: DavPropertyName) =>
  davElement(propertyElement(name));

export const createDavProperty = (name: string, value?: string) => {
  const property = propertyElement({
    namespaceURI: DAV_NAMESPACE,
    localName: name,
  });
  if (value !== undefined)
    property.appendChild(property.ownerDocument!.createTextNode(value));
  return davElement(property);
};

export const serializeProperty = (property: DavProperty) =>
  serializer.serializeToString(xmlElement(property.element));

export const parseProperty = (xml: string): DavProperty => ({
  element: davElement(parseRoot(xml)),
});

export const parsePropfind = (xml: string): DavPropfindRequest => {
  const root = parseRoot(xml);
  const prop = child(root, DAV_NAMESPACE, "prop");
  if (prop)
    return {
      kind: "prop",
      names: children(prop).map((element) => propertyName(davElement(element))),
    };
  if (child(root, DAV_NAMESPACE, "propname")) return { kind: "propname" };
  const include = child(root, DAV_NAMESPACE, "include");
  return {
    kind: "allprop",
    ...(include
      ? {
          include: children(include).map((element) =>
            propertyName(davElement(element)),
          ),
        }
      : {}),
  };
};

export const parseProppatch = (xml: string): DavProppatchInstruction[] => {
  const instructions: DavProppatchInstruction[] = [];
  for (const operation of children(parseRoot(xml))) {
    const kind = localName(operation);
    if (
      operation.namespaceURI !== DAV_NAMESPACE ||
      (kind !== "set" && kind !== "remove")
    )
      continue;
    const prop = child(operation, DAV_NAMESPACE, "prop");
    if (!prop) continue;
    for (const element of children(prop)) {
      const property = davElement(element);
      if (kind === "set")
        instructions.push({ kind, property: { element: property } });
      else instructions.push({ kind, name: propertyName(property) });
    }
  }
  return instructions;
};

export const parseMkcol = (xml: string): DavProperty[] => {
  const properties: DavProperty[] = [];
  for (const set of children(parseRoot(xml))) {
    if (set.namespaceURI !== DAV_NAMESPACE || localName(set) !== "set")
      continue;
    const prop = child(set, DAV_NAMESPACE, "prop");
    if (!prop) continue;
    for (const element of children(prop))
      properties.push({ element: davElement(element) });
  }
  return properties;
};

export const parseLockInfo = (
  xml: string,
): { scope: LockScope; owner?: DavElement } => {
  const root = parseRoot(xml);
  const lockScope = child(root, DAV_NAMESPACE, "lockscope");
  const owner = child(root, DAV_NAMESPACE, "owner");
  return {
    scope:
      lockScope && child(lockScope, DAV_NAMESPACE, "shared")
        ? "shared"
        : "exclusive",
    ...(owner ? { owner: davElement(owner) } : {}),
  };
};

export const parseSyncCollection = (xml: string) => {
  const root = parseRoot(xml);
  const token = child(root, DAV_NAMESPACE, "sync-token")?.textContent?.trim();
  const level = child(root, DAV_NAMESPACE, "sync-level")?.textContent?.trim();
  const prop = child(root, DAV_NAMESPACE, "prop");
  return {
    syncToken: token || undefined,
    syncLevel: level,
    properties: prop
      ? children(prop).map((element) => propertyName(davElement(element)))
      : [],
  };
};

export const supportedLockProperty = (
  scopes: readonly LockScope[],
): DavProperty => {
  const property = xmlElement(createDavProperty("supportedlock"));
  for (const scope of scopes) {
    const entry = xmlElement(
      appendDavElement(davElement(property), "lockentry"),
    );
    const scopeElement = xmlElement(
      appendDavElement(davElement(entry), "lockscope"),
    );
    appendDavElement(davElement(scopeElement), scope);
    const typeElement = xmlElement(
      appendDavElement(davElement(entry), "locktype"),
    );
    appendDavElement(davElement(typeElement), "write");
  }
  return { element: davElement(property) };
};

export const supportedReportSetProperty = (): DavProperty => {
  const property = xmlElement(createDavProperty("supported-report-set"));
  const supportedReport = xmlElement(
    appendDavElement(davElement(property), "supported-report"),
  );
  const report = xmlElement(
    appendDavElement(davElement(supportedReport), "report"),
  );
  appendDavElement(davElement(report), "sync-collection");
  return { element: davElement(property) };
};

interface DavResponse {
  href: string;
  propstats: readonly DavPropStat[];
  status?: number;
}

export const multistatus = (
  responses: readonly DavResponse[],
  syncToken?: string,
) => {
  const { document, root } = documentRoot("multistatus");
  for (const response of responses) {
    const element = xmlElement(appendDavElement(davElement(root), "response"));
    appendDavElement(davElement(element), "href", response.href);
    if (response.status !== undefined) appendStatus(element, response.status);
    for (const propstat of response.propstats)
      appendPropstat(element, propstat);
  }
  if (syncToken) appendDavElement(davElement(root), "sync-token", syncToken);
  return `<?xml version="1.0" encoding="utf-8"?>${serializer.serializeToString(
    document,
  )}`;
};

export const lockResponse = (lock: Lock) => {
  const { document, root } = documentRoot("prop");
  const discovery = xmlElement(
    appendDavElement(davElement(root), "lockdiscovery"),
  );
  appendActiveLock(discovery, lock);
  return `<?xml version="1.0" encoding="utf-8"?>${serializer.serializeToString(
    document,
  )}`;
};

export const mkcolResponse = (propstats: readonly DavPropStat[]) => {
  const { document, root } = documentRoot("mkcol-response");
  for (const propstat of propstats) appendPropstat(root, propstat);
  return `<?xml version="1.0" encoding="utf-8"?>${serializer.serializeToString(
    document,
  )}`;
};

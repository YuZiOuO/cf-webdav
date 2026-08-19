import {
  DOMImplementation,
  DOMParser,
  XMLSerializer,
  type Element as XmlElement,
} from "@xmldom/xmldom";
import type {
  PropfindRequest,
  ProppatchInstruction,
  PropStat,
  Lock,
  LockScope,
} from "./types";
import {
  appendDavElement,
  DAV_NAMESPACE,
  elementChildren,
  elementLocalName,
  propertyName,
} from "../core/xml";

type DomElement = Element;

const serializer = new XMLSerializer();

const xmlElement = (element: DomElement) => element as unknown as XmlElement;

const davElement = (element: XmlElement) => element as unknown as DomElement;

const child = (parent: XmlElement, namespace: string, name: string) =>
  elementChildren(parent).find(
    (element) =>
      element.namespaceURI === namespace && elementLocalName(element) === name,
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
  if (!root || elementLocalName(root) === "parsererror")
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

const appendPropstat = (parent: XmlElement, propstat: PropStat) => {
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

export const parsePropfind = (xml: string): PropfindRequest => {
  const root = parseRoot(xml);
  const prop = child(root, DAV_NAMESPACE, "prop");
  if (prop)
    return {
      kind: "prop",
      names: elementChildren(prop).map((element) =>
        propertyName(davElement(element)),
      ),
    };
  if (child(root, DAV_NAMESPACE, "propname")) return { kind: "propname" };
  const include = child(root, DAV_NAMESPACE, "include");
  return {
    kind: "allprop",
    ...(include
      ? {
          include: elementChildren(include).map((element) =>
            propertyName(davElement(element)),
          ),
        }
      : {}),
  };
};

export const parseProppatch = (xml: string): ProppatchInstruction[] => {
  const instructions: ProppatchInstruction[] = [];
  for (const operation of elementChildren(parseRoot(xml))) {
    const kind = elementLocalName(operation);
    if (
      operation.namespaceURI !== DAV_NAMESPACE ||
      (kind !== "set" && kind !== "remove")
    )
      continue;
    const prop = child(operation, DAV_NAMESPACE, "prop");
    if (!prop) continue;
    for (const element of elementChildren(prop)) {
      const property = davElement(element);
      if (kind === "set")
        instructions.push({ kind, property: { element: property } });
      else instructions.push({ kind, name: propertyName(property) });
    }
  }
  return instructions;
};

export const parseLockInfo = (
  xml: string,
): { scope: LockScope; owner?: DomElement } => {
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

interface ResponseItem {
  href: string;
  propstats: readonly PropStat[];
  status?: number;
}

export const multistatus = (responses: readonly ResponseItem[]) => {
  const { document, root } = documentRoot("multistatus");
  for (const response of responses) {
    const element = xmlElement(appendDavElement(davElement(root), "response"));
    appendDavElement(davElement(element), "href", response.href);
    if (response.status !== undefined) appendStatus(element, response.status);
    for (const propstat of response.propstats)
      appendPropstat(element, propstat);
  }
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

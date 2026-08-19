import type { Property, PropStat } from "../rfc4918/types";
import { DAV_NAMESPACE, elementChildren } from "../core/xml";
import {
  DOMParser,
  XMLSerializer,
  type Element as XmlElement,
} from "@xmldom/xmldom";

export const parseMkcol = (xml: string): Property[] => {
  const root = new DOMParser().parseFromString(
    xml,
    "application/xml",
  ).documentElement;
  if (!root) throw new Error("Invalid XML document");
  const properties: Property[] = [];
  for (const set of elementChildren(root)) {
    if (set.namespaceURI !== DAV_NAMESPACE || set.localName !== "set") continue;
    const prop = elementChildren(set).find(
      (element) =>
        element.namespaceURI === DAV_NAMESPACE && element.localName === "prop",
    );
    if (!prop) continue;
    for (const element of elementChildren(prop))
      properties.push({ element: element as unknown as Element });
  }
  return properties;
};

export const mkcolResponse = (propstats: readonly PropStat[]) => {
  const serializer = new XMLSerializer();
  const document = new DOMParser().parseFromString(
    '<D:mkcol-response xmlns:D="DAV:"/>',
    "application/xml",
  );
  const root = document.documentElement;
  if (!root) throw new Error("Invalid XML document");
  for (const propstat of propstats) {
    const propstatElement = document.createElementNS(
      DAV_NAMESPACE,
      "D:propstat",
    );
    const properties = document.createElementNS(DAV_NAMESPACE, "D:prop");
    for (const property of propstat.properties)
      properties.appendChild(
        document.importNode(property.element as unknown as XmlElement, true),
      );
    propstatElement.appendChild(properties);
    const status = document.createElementNS(DAV_NAMESPACE, "D:status");
    status.textContent =
      `HTTP/1.1 ${propstat.status} ${propstat.status === 403 ? "Forbidden" : propstat.status === 424 ? "Failed Dependency" : ""}`.trim();
    propstatElement.appendChild(status);
    root.appendChild(propstatElement);
  }
  return `<?xml version="1.0" encoding="utf-8"?>${serializer.serializeToString(document)}`;
};

import { DOMParser } from "@xmldom/xmldom";
import type { DavPropertyName } from "../../interfaces";
import { DAV_NAMESPACE, elementChildren, propertyName } from "../core/xml";
import { multistatus as baseMultistatus } from "../rfc4918/xml";

export const syncMultistatus = (
  responses: Parameters<typeof baseMultistatus>[0],
  syncToken: string,
) => {
  const body = baseMultistatus(responses);
  return body.replace(
    "</D:multistatus>",
    `<D:sync-token>${syncToken}</D:sync-token></D:multistatus>`,
  );
};

export const parseSyncCollection = (xml: string) => {
  const root = new DOMParser().parseFromString(
    xml,
    "application/xml",
  ).documentElement;
  if (!root) throw new Error("Invalid XML document");
  const find = (name: string) =>
    elementChildren(root).find(
      (element) =>
        element.namespaceURI === DAV_NAMESPACE && element.localName === name,
    );
  const prop = find("prop");
  return {
    syncToken: find("sync-token")?.textContent?.trim() || undefined,
    syncLevel: find("sync-level")?.textContent?.trim(),
    properties: prop
      ? elementChildren(prop).map((element): DavPropertyName =>
          propertyName(element as unknown as Element),
        )
      : [],
  };
};

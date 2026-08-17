import type { DavResource } from "../core/resource";
import type { DavResourceInfo } from "../core/types";
import type { DavLiveProperty } from "../rfc4918/properties";
import type { DavPropertyName } from "../rfc4918/types";
import { DAV_NAMESPACE, createDavProperty } from "../core/xml";
import type { DavQuotaProvider } from "./types";

export const quotaProtectedPropertyNames: readonly DavPropertyName[] = [
  { namespaceURI: DAV_NAMESPACE, localName: "quota-available-bytes" },
  { namespaceURI: DAV_NAMESPACE, localName: "quota-used-bytes" },
];

export const quotaLiveProperties = async (
  provider: DavQuotaProvider,
  resource: DavResource,
  info: DavResourceInfo,
  include: boolean,
): Promise<readonly DavLiveProperty[]> => {
  if (!include || info.kind !== "collection") return [];
  const value = await provider(resource.path);
  if (!value) return [];
  return [
    {
      name: {
        namespaceURI: DAV_NAMESPACE,
        localName: "quota-available-bytes",
      },
      property: {
        element: createDavProperty(
          "quota-available-bytes",
          String(value.availableBytes ?? Number.MAX_SAFE_INTEGER),
        ),
      },
    },
    {
      name: { namespaceURI: DAV_NAMESPACE, localName: "quota-used-bytes" },
      property: {
        element: createDavProperty("quota-used-bytes", String(value.usedBytes)),
      },
    },
  ];
};

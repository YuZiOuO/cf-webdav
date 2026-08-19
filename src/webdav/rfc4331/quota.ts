import type { Resource } from "../core/resource";
import type { ResourceInfo } from "../core/types";
import type { LiveProperty } from "../rfc4918/properties";
import type { PropertyName } from "../rfc4918/types";
import { DAV_NAMESPACE, createDavProperty } from "../core/xml";
import type { QuotaProvider } from "./types";

export const quotaProtectedPropertyNames: readonly PropertyName[] = [
  { namespaceURI: DAV_NAMESPACE, localName: "quota-available-bytes" },
  { namespaceURI: DAV_NAMESPACE, localName: "quota-used-bytes" },
];

export const quotaLiveProperties = async (
  provider: QuotaProvider,
  resource: Resource,
  info: ResourceInfo,
  include: boolean,
): Promise<readonly LiveProperty[]> => {
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

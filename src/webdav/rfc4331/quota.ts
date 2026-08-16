import type { Path, Resource } from "../../interfaces/file_system";
import type { StorageQuotaProvider } from "../../interfaces/file_system";
import type { Quota, QuotaProvider } from "../../interfaces/webdav/rfc4331";
import type { DavPropertyExtension } from "../core/properties";
import { DAV_NAMESPACE, createDavProperty } from "../core/xml";

export class FileSystemQuotaProvider implements QuotaProvider {
  constructor(private readonly quota: StorageQuotaProvider) {}

  async getQuota(collection: Path): Promise<Quota> {
    const storage = await this.quota.getQuota(collection);
    return {
      usedBytes: storage.usedBytes,
      availableBytes: storage.availableBytes ?? Number.MAX_SAFE_INTEGER,
    };
  }
}

export class DavQuotaProperties implements DavPropertyExtension {
  constructor(private readonly quota: QuotaProvider) {}

  async liveProperties(path: Path, resource: Resource, include: boolean) {
    if (!include || resource.kind !== "directory") return [];
    const value = await this.quota.getQuota(path);
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
            String(value.availableBytes),
          ),
        },
      },
      {
        name: { namespaceURI: DAV_NAMESPACE, localName: "quota-used-bytes" },
        property: {
          element: createDavProperty(
            "quota-used-bytes",
            String(value.usedBytes),
          ),
        },
      },
    ];
  }

  isProtected(name: { namespaceURI: string; localName: string }) {
    return (
      name.namespaceURI === DAV_NAMESPACE &&
      (name.localName === "quota-available-bytes" ||
        name.localName === "quota-used-bytes")
    );
  }
}

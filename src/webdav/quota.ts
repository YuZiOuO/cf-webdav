import type { Path } from "../interfaces/file_system";
import type { StorageQuotaProvider } from "../interfaces/file_system";
import type { Quota, QuotaProvider } from "../interfaces/webdav/rfc4331";

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

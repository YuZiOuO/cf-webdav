import type { Path } from "../file_system";

/** RFC 4331 quota properties for a collection. */
export interface Quota {
  availableBytes: number;
  usedBytes: number;
}

export interface QuotaProvider {
  getQuota(collection: Path): Promise<Quota | undefined>;
}

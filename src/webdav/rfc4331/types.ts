import type { DavPath } from "../core/types";

export interface Quota {
  usedBytes: number;
  availableBytes?: number;
}

export type DavQuotaProvider = (path: DavPath) => Promise<Quota | undefined>;

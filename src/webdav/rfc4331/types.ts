import type { Path } from "../core/types";

export interface Quota {
  usedBytes: number;
  availableBytes?: number;
}

export type QuotaProvider = (path: Path) => Promise<Quota | undefined>;

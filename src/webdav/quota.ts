import type { QuotaProvider } from "../interfaces/webdav/rfc4331";

/** R2 does not expose a quota limit, so RFC 4331 properties are intentionally omitted. */
export class UnlimitedQuotaProvider implements QuotaProvider {
  getQuota(): ReturnType<QuotaProvider["getQuota"]> {
    return Promise.resolve(undefined);
  }
}

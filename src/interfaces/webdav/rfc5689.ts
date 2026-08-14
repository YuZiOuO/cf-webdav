import type { Directory, Path } from "../file_system";
import type { DavProperty, DavPropStat } from "./rfc4918";

/** An RFC 5689 DAV:mkcol-response element. */
export interface MkcolResponse {
  propstats: readonly DavPropStat[];
}

/** RFC 5689 extended MKCOL with atomic property initialization. */
export interface ExtendedMkcol {
  mkcol(
    path: Path,
    properties: readonly DavProperty[],
  ): Promise<Directory | MkcolResponse>;
}

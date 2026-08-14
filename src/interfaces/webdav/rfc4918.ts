import type { EntityTag } from "../object_store";
import type { Path, Resource } from "../file_system";

declare const lockTokenType: unique symbol;

export type LockToken = string & {
  readonly [lockTokenType]: "LockToken";
};

/** An XML expanded name: namespace URI plus local name. */
export interface DavPropertyName {
  namespaceURI: string;
  localName: string;
}

/** A WebDAV property represented by its complete XML element. */
export interface DavProperty {
  element: Element;
}

export type DavPropfindRequest =
  | {
      kind: "allprop";
      include?: readonly DavPropertyName[];
    }
  | {
      kind: "propname";
    }
  | {
      kind: "prop";
      names: readonly DavPropertyName[];
    };

/** An RFC 4918 DAV:propstat element. */
export interface DavPropStat {
  properties: readonly DavProperty[];
  status: number;
}

/** A PROPPATCH instruction. Arrays of these preserve document order. */
export type DavProppatchInstruction =
  | {
      kind: "set";
      property: DavProperty;
    }
  | {
      kind: "remove";
      name: DavPropertyName;
    };

/**
 * Resolves live and dead properties. PROPPATCH instructions must be applied
 * in document order, atomically.
 */
export interface DavPropertyService {
  propfind(
    path: Path,
    resource: Resource,
    request: DavPropfindRequest,
  ): Promise<readonly DavPropStat[]>;
  proppatch(
    path: Path,
    resource: Resource,
    instructions: readonly DavProppatchInstruction[],
  ): Promise<readonly DavPropStat[]>;
}

export type DavIfCondition =
  | {
      kind: "state-token";
      token: string;
      not?: boolean;
    }
  | {
      kind: "entity-tag";
      etag: EntityTag;
      not?: boolean;
    };

/**
 * A single RFC 4918 If-list. An omitted resource represents a no-tag list
 * and applies to the request URI.
 */
export interface DavIfList {
  resource?: Path;
  conditions: readonly DavIfCondition[];
}

/** A parsed RFC 4918 If header. */
export type DavIfHeader = readonly DavIfList[];

export type LockScope = "exclusive" | "shared";
export type LockDepth = "0" | "infinity";

/** A lock timeout in seconds, or the RFC 4918 Infinite value. */
export type LockTimeout = number | "infinite";

export interface Lock {
  token: LockToken;
  root: Path;
  scope: LockScope;
  depth: LockDepth;
  timeout?: LockTimeout;
  owner?: Element;
}

export interface LockRequest {
  scope: LockScope;
  depth: LockDepth;
  timeout?: LockTimeout;
  owner?: Element;
}

/** RFC 4918 Class 2 write locks and lock discovery. */
export interface LockManager {
  /** Returns lock scopes advertised through DAV:supportedlock at path. */
  getSupportedLockScopes(path: Path): Promise<readonly LockScope[]>;
  /** Returns active locks whose scope contains path, including ancestor locks. */
  getLocks(path: Path): Promise<readonly Lock[]>;
  lock(path: Path, request: LockRequest): Promise<Lock>;
  refresh(path: Path, token: LockToken, timeout?: LockTimeout): Promise<Lock>;
  unlock(path: Path, token: LockToken): Promise<void>;
}

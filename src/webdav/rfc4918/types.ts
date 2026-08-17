import type { DavPath } from "../core/types";

export interface DavPropertyName {
  namespaceURI: string;
  localName: string;
}

export interface DavProperty {
  element: Element;
}

export type DavPropfindRequest =
  | { kind: "allprop"; include?: readonly DavPropertyName[] }
  | { kind: "propname" }
  | { kind: "prop"; names: readonly DavPropertyName[] };

export interface DavPropStat {
  properties: readonly DavProperty[];
  status: number;
}

export type DavProppatchInstruction =
  | { kind: "set"; property: DavProperty }
  | { kind: "remove"; name: DavPropertyName };

export type DavIfCondition =
  | { kind: "state-token"; token: string; not?: boolean }
  | { kind: "entity-tag"; etag: string; not?: boolean };

export interface DavIfList {
  resource?: DavPath;
  conditions: readonly DavIfCondition[];
}

export type DavIfHeader = readonly DavIfList[];

export type LockToken = string & { readonly __lockToken: unique symbol };
export type LockScope = "exclusive" | "shared";
export type LockDepth = "0" | "infinity";
export type LockTimeout = number | "infinite";

export interface Lock {
  token: LockToken;
  root: DavPath;
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

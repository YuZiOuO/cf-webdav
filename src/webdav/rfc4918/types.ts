import type {
  Path,
  Property,
  PropertyName,
  LockDepth,
  LockScope,
} from "../core/types";

export type {
  Property,
  PropertyName,
  LockDepth,
  LockScope,
} from "../core/types";

export type PropfindRequest =
  | { kind: "allprop"; include?: readonly PropertyName[] }
  | { kind: "propname" }
  | { kind: "prop"; names: readonly PropertyName[] };

export interface PropStat {
  properties: readonly Property[];
  status: number;
}

export type ProppatchInstruction =
  { kind: "set"; property: Property } | { kind: "remove"; name: PropertyName };

export type IfCondition =
  | { kind: "state-token"; token: string; not?: boolean }
  | { kind: "entity-tag"; etag: string; not?: boolean };

export interface IfList {
  resource?: Path;
  conditions: readonly IfCondition[];
}

export type IfHeader = readonly IfList[];

export type LockToken = string & { readonly __lockToken: unique symbol };
export interface Lock {
  token: LockToken;
  root: Path;
  scope: LockScope;
  depth: LockDepth;
  timeout?: number | "infinite";
  owner?: Element;
}

export interface LockRequest {
  scope: LockScope;
  depth: LockDepth;
  timeout?: number | "infinite";
  owner?: Element;
}

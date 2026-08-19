type StateError =
  | "not-found"
  | "already-exists"
  | "parent-not-found"
  | "not-directory"
  | "directory-not-empty"
  | "precondition-failed"
  | "locked"
  | "invalid-destination"
  | "invalid-sync-token";

export type StateResult<T> =
  { ok: true; value: T } | { ok: false; error: StateError };

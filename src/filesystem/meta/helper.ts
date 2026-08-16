import type { EntityTag, Preconditions } from "../../interfaces";
import { FileSystemError } from "../errors";
import type { StateResult } from "./errors";

// Entity tags and HTTP precondition checks.
export const newEntityTag = () => `"${crypto.randomUUID()}"` as EntityTag;

export const matchesPreconditions = (
  etag: EntityTag | undefined,
  preconditions?: Preconditions,
) => {
  if (preconditions?.ifMatch) {
    if (!etag) return false;
    if (preconditions.ifMatch !== "*" && preconditions.ifMatch !== etag)
      return false;
  }
  if (
    preconditions?.ifNoneMatch &&
    etag &&
    (preconditions.ifNoneMatch === "*" || preconditions.ifNoneMatch === etag)
  )
    return false;
  return true;
};

// Converts Durable Object RPC results into filesystem errors at the boundary.
export const unwrapState = <T>(result: StateResult<T>) => {
  if (result.ok) return result.value;

  switch (result.error) {
    case "not-found":
      throw new FileSystemError("not-found", "Resource not found");
    case "already-exists":
      throw new FileSystemError("already-exists", "Resource already exists");
    case "parent-not-found":
      throw new FileSystemError(
        "parent-not-found",
        "Parent directory not found",
      );
    case "not-directory":
      throw new FileSystemError("not-directory", "Parent is not a directory");
    case "directory-not-empty":
      throw new FileSystemError(
        "directory-not-empty",
        "Directory is not empty",
      );
    case "precondition-failed":
      throw new FileSystemError("precondition-failed", "Precondition failed");
    case "locked":
      throw new FileSystemError("locked", "Resource is locked");
    case "invalid-destination":
      throw new FileSystemError("invalid-path", "Invalid destination");
    case "invalid-sync-token":
      throw new FileSystemError(
        "precondition-failed",
        "Invalid synchronization token",
      );
  }
};

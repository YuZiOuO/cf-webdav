export type FileSystemErrorCode =
  | "invalid-path"
  | "not-found"
  | "already-exists"
  | "parent-not-found"
  | "not-directory"
  | "not-file"
  | "directory-not-empty"
  | "locked"
  | "precondition-failed"
  | "range-not-satisfiable"
  | "inconsistent";

export class FileSystemError extends Error {
  constructor(
    readonly code: FileSystemErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FileSystemError";
  }
}

import { ObjectStoreFileSystem } from "./fs";
import { R2ObjectStore } from "./object";

export { ObjectStoreFileSystem } from "./fs";
export { FileSystemError } from "./errors";
export type { FileSystemErrorCode } from "./errors";
export { R2ObjectStore } from "./object";
export { FileSystemState } from "./meta";

export const createR2FileSystem = (env: CloudflareBindings) =>
  new ObjectStoreFileSystem(
    new R2ObjectStore(env.BUCKET),
    env.FileSystemState.getByName("root"),
  );

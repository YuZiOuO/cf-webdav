import { FileSystemError } from "../errors";
import type { Path } from "../../interfaces";
import { unwrapState } from "../meta";
import { deleteReleasedObjects } from "./helper";
import type { FileSystemDependencies } from "./helper";

export const remove = async (
  deps: FileSystemDependencies,
  path: Path,
  options?: { recursive?: boolean },
) => {
  if (path === "/")
    throw new FileSystemError("invalid-path", "Cannot delete root directory");
  const removed = unwrapState(
    await deps.state.removeNode(path, options?.recursive ?? false),
  );
  await deleteReleasedObjects(deps.objects, removed.releasedObjectKeys);
};

import { FileSystemError } from "../errors";
import type { Path } from "../../interfaces";
import { unwrapState } from "../meta";
import { deleteReleasedObjects, toNode } from "./helper";
import type { FileSystemDependencies } from "./helper";

export const copy = async (
  deps: FileSystemDependencies,
  source: Path,
  destination: Path,
  options: { recursive: boolean; overwrite: boolean },
) => {
  if (source === "/" || destination === "/")
    throw new FileSystemError("invalid-path", "Invalid source or destination");
  const copied = unwrapState(
    await deps.state.copyNode(
      source,
      destination,
      options.recursive,
      options.overwrite,
    ),
  );
  await deleteReleasedObjects(deps.objects, copied.releasedObjectKeys);
  return toNode(copied.node);
};

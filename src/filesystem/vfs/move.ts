import { relative } from "node:path/posix";
import { FileSystemError } from "../errors";
import type { Path } from "../../interfaces";
import { unwrapState } from "../meta";
import { deleteReleasedObjects, toNode } from "./helper";
import type { FileSystemDependencies } from "./helper";

export const move = async (
  deps: FileSystemDependencies,
  source: Path,
  destination: Path,
  options: { overwrite: boolean },
) => {
  const destinationIsDescendant = relative(source, destination);
  if (
    source === "/" ||
    destination === "/" ||
    (destinationIsDescendant !== "" &&
      !destinationIsDescendant.startsWith(".."))
  )
    throw new FileSystemError("invalid-path", "Invalid source or destination");
  const moved = unwrapState(
    await deps.state.moveNode(source, destination, options.overwrite),
  );
  await deleteReleasedObjects(deps.objects, moved.releasedObjectKeys);
  return toNode(moved.node);
};

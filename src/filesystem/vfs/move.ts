import { relative } from "node:path/posix";
import { FileSystemError } from "../errors";
import type { MoveOptions, Path } from "../../interfaces";
import { unwrapState } from "../meta";
import { deleteReleasedObjects, toResource } from "./helper";
import type { FileSystemDependencies } from "./helper";

export const move = async (
  deps: FileSystemDependencies,
  source: Path,
  destination: Path,
  options: MoveOptions,
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
    await deps.state.moveResource(source, destination, options.overwrite),
  );
  await deleteReleasedObjects(deps.objects, moved.releasedObjectKeys);
  return toResource(moved.resource);
};

import type { Node, NodeId, ObjectKey, ObjectStore } from "../../interfaces";
import type { FileSystemState, StoredNode } from "../meta";

// Dependencies shared by VFS operations.
export interface FileSystemDependencies {
  objects: ObjectStore;
  state: DurableObjectStub<FileSystemState>;
}

// Object content helpers used when bridging metadata and object storage.
export const objectKey = () => crypto.randomUUID() as ObjectKey;

export const nodeId = () => crypto.randomUUID() as NodeId;

export const toNode = (stored: StoredNode): Node => {
  const base = {
    id: stored.id as NodeId,
    createdAt: new Date(stored.createdAt),
    lastModified: new Date(stored.lastModified),
  };
  if (stored.kind === "directory") return { ...base, kind: "directory" };
  return {
    ...base,
    kind: "file",
    size: stored.size,
  };
};

export const deleteReleasedObjects = async (
  objects: ObjectStore,
  objectKeys: readonly string[],
) => {
  await Promise.all(
    objectKeys.map(async (key) => {
      try {
        await objects.delete(key as ObjectKey);
      } catch {
        console.error("Unable to delete released object");
      }
    }),
  );
};

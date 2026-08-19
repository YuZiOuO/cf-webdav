import type {
  ObjectKey,
  ObjectStore,
  Resource,
  ResourceId,
} from "../../interfaces";
import type { FileSystemState, StoredResource } from "../meta";

// Dependencies shared by VFS operations.
export interface FileSystemDependencies {
  objects: ObjectStore;
  state: DurableObjectStub<FileSystemState>;
}

// Object content helpers used when bridging metadata and object storage.
export const objectKey = (id: ResourceId) =>
  `resources/${id}/${crypto.randomUUID()}` as ObjectKey;

export const resourceId = () => crypto.randomUUID() as ResourceId;

export const toResource = (stored: StoredResource): Resource => {
  const base = {
    id: stored.id as ResourceId,
    createdAt: new Date(stored.createdAt),
    lastModified: new Date(stored.lastModified),
  };
  if (stored.kind === "directory") return { ...base, kind: "directory" };
  return {
    ...base,
    kind: "file",
    size: stored.size,
    ...(stored.contentType ? { contentType: stored.contentType } : {}),
  };
};

export const emptyBody = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

export const deleteReleasedObjects = async (
  objects: ObjectStore,
  objectKeys: readonly string[],
) => {
  await Promise.all(
    objectKeys.map(async (key) => {
      try {
        await objects.delete(key as ObjectKey);
      } catch (error) {
        console.error("Unable to delete released object", key, error);
      }
    }),
  );
};

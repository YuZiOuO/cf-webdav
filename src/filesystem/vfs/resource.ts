import type { Resource, ResourceId } from "../../interfaces/file_system";
import type { StoredResource } from "../meta/types";

export const resourceId = () => crypto.randomUUID() as ResourceId;

export const toResource = (stored: StoredResource): Resource => {
  const base = {
    id: stored.id as ResourceId,
    etag: stored.etag,
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

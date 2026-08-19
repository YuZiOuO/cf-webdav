import type { EntityTag } from "./types";

export const newETag = () => `"${crypto.randomUUID()}"` as EntityTag;

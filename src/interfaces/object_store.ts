declare const objectKeyType: unique symbol;

/** An opaque key within a single object-storage namespace. */
export type ObjectKey = string & {
  readonly [objectKeyType]: "ObjectKey";
};

/** A byte range with an inclusive end offset. */
export interface ByteRange {
  start: number;
  end?: number;
}

/**
 * Content storage only. Object keys must not be derived from filesystem
 * paths, and filesystem paths must not be exposed through this interface.
 */
export interface ObjectStore {
  get(
    key: ObjectKey,
    options?: { range?: ByteRange },
  ): Promise<{ body: ReadableStream<Uint8Array> } | undefined>;
  put(
    key: ObjectKey,
    body: ReadableStream<Uint8Array>,
  ): Promise<{ size: number }>;
  delete(key: ObjectKey): Promise<void>;
}

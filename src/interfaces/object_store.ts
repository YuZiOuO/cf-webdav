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

export interface ObjectMetadata {
  size: number;
  contentType?: string;
}

export interface ObjectBody extends ObjectMetadata {
  body: ReadableStream<Uint8Array>;
  range?: ByteRange;
}

export interface ObjectData {
  body: ReadableStream<Uint8Array>;
  size: number;
  contentType?: string;
}

export interface GetObjectOptions {
  range?: ByteRange;
}

/**
 * Content storage only. Object keys must not be derived from filesystem
 * paths, and filesystem paths must not be exposed through this interface.
 */
export interface ObjectStore {
  head(key: ObjectKey): Promise<ObjectMetadata | undefined>;
  get(
    key: ObjectKey,
    options?: GetObjectOptions,
  ): Promise<ObjectBody | undefined>;
  put(key: ObjectKey, data: ObjectData): Promise<ObjectMetadata>;
  delete(key: ObjectKey): Promise<void>;
}

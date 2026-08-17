/** A decoded absolute URL path used inside the WebDAV implementation. */
export type DavPath = string;

export interface DavByteRange {
  start: number;
  end?: number;
}

export interface DavFile {
  kind: "file";
  lastModified: Date;
  contentLength: number;
  contentType?: string;
}

export interface DavCollection {
  kind: "collection";
  lastModified: Date;
}

export type DavResourceInfo = DavFile | DavCollection;

export interface DavFileContent {
  file: DavFile;
  body: ReadableStream<Uint8Array>;
  range?: DavByteRange;
}

export interface DavFileData {
  body: ReadableStream<Uint8Array>;
  contentLength: number;
  contentType?: string;
}

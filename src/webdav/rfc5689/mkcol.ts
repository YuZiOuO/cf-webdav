import type {
  DavProperty,
  Directory,
  ExtendedMkcol,
  FileSystem,
  MkcolResponse,
  Path,
} from "../../interfaces";
import type { WebDavState } from "../core/state";
import { DAV_NAMESPACE, propertyChildren, propertyName } from "../core/xml";
import {
  protectedPropertyNames,
  propertyKey,
  storedProperty,
} from "../core/properties";

export class DavMkcol implements ExtendedMkcol {
  constructor(
    private readonly filesystem: FileSystem,
    private readonly state: DurableObjectStub<WebDavState>,
  ) {}

  async mkcol(
    path: Path,
    properties: readonly DavProperty[],
  ): Promise<Directory | MkcolResponse> {
    if (
      properties.some((property) => {
        const { namespaceURI, localName } = propertyName(property.element);
        return (
          namespaceURI === DAV_NAMESPACE &&
          localName === "resourcetype" &&
          propertyChildren(property).some(
            (child) =>
              child.namespaceURI !== DAV_NAMESPACE ||
              child.localName !== "collection",
          )
        );
      })
    ) {
      return {
        propstats: properties.map((property) => ({
          properties: [property],
          status: 403,
        })),
      };
    }

    const deadProperties = properties
      .filter(
        (property) =>
          !protectedPropertyNames.has(
            propertyKey(propertyName(property.element)),
          ),
      )
      .map(storedProperty);
    const directory = await this.filesystem.mkdir(path);
    const result = await this.state.patchProperties(
      path,
      deadProperties.map((property) => ({ kind: "set" as const, property })),
    );
    if (!result.ok) throw new Error(result.error);
    return directory;
  }
}

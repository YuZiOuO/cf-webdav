import type { Directory, Path } from "../interfaces/file_system";
import type { DavProperty } from "../interfaces/webdav/rfc4918";
import type {
  ExtendedMkcol,
  MkcolResponse,
} from "../interfaces/webdav/rfc5689";
import { toResource } from "../filesystem/vfs/resource";
import { unwrapState } from "../filesystem/meta/helper";
import type { FileSystemState } from "../filesystem/meta";
import { DAV_NAMESPACE, propertyChildren, propertyName } from "./xml";
import {
  protectedPropertyNames,
  propertyKey,
  storedProperty,
} from "./property";

export class DavMkcol implements ExtendedMkcol {
  constructor(private readonly state: DurableObjectStub<FileSystemState>) {}

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
    return toResource(
      unwrapState(
        await this.state.createDirectoryWithProperties(
          path,
          {},
          deadProperties,
        ),
      ),
    ) as Directory;
  }
}

import assert from "node:assert/strict";
import {
  DAV_NAMESPACE,
  TEST_NAMESPACE,
  assertStatus,
  childElement,
  parseDavMultiStatus,
  propfind,
  propfindBody,
  propertyStatus,
  requiredProperty,
  responseForPath,
  rfcTest,
  type WebDavTestClient,
} from "./support";

export function registerRfc5689Tests(client: WebDavTestClient) {
  rfcTest(
    {
      id: "RFC5689-03.1-001",
      rfc: "5689",
      section: "3.1",
      requirement: "MUST",
      title: "OPTIONS advertises extended-mkcol support",
      prerequisites: ["A collection supports extended MKCOL."],
      request: "OPTIONS {collection}",
      assertions: ["The DAV response header contains extended-mkcol."],
      alternatives: [],
    },
    async () => {
      const collection = await client.createCollection(
        "extended-mkcol-options",
      );
      const response = await client.request(collection, { method: "OPTIONS" });
      assert.ok(response.ok, `OPTIONS returned ${response.status}`);
      const dav = response.headers.get("DAV");
      assert.ok(dav, "OPTIONS response is missing the DAV header");
      assert.ok(
        dav
          .split(",")
          .map((value) => value.trim())
          .includes("extended-mkcol"),
        `DAV header does not advertise extended-mkcol: ${dav}`,
      );
    },
  );

  rfcTest(
    {
      id: "RFC5689-03-001",
      rfc: "5689",
      section: "3",
      requirement: "MUST",
      title: "Extended MKCOL initializes properties in document order",
      prerequisites: [
        "The target is unmapped and its parent collection exists.",
      ],
      request:
        "MKCOL {collection}; Content-Type: application/xml; DAV:mkcol with two ordered DAV:set instructions",
      assertions: [
        "The response is 201.",
        "The created collection has DAV:collection and the dead property's later value.",
      ],
      alternatives: ["A successful response body may be empty."],
    },
    async () => {
      const collection = client.newPath("extended-mkcol-success");
      const response = await client.request(collection, {
        method: "MKCOL",
        headers: { "Content-Type": "application/xml" },
        body: '<D:mkcol xmlns:D="DAV:" xmlns:T="urn:cf-r2-webdav:rfc-test"><D:set><D:prop><D:resourcetype><D:collection/></D:resourcetype><T:label>first</T:label></D:prop></D:set><D:set><D:prop><T:label>second</T:label></D:prop></D:set></D:mkcol>',
      });
      await assertStatus(response, 201);

      const found = await propfind(
        client,
        collection,
        propfindBody("<D:resourcetype/><T:label/>"),
      );
      await assertStatus(found, 207);
      const item = responseForPath(
        parseDavMultiStatus(await found.text()),
        client,
        collection,
      );
      assert.equal(
        propertyStatus(item.propstats, DAV_NAMESPACE, "resourcetype"),
        200,
      );
      assert.ok(
        childElement(
          requiredProperty(item.propstats, DAV_NAMESPACE, "resourcetype"),
          DAV_NAMESPACE,
          "collection",
        ),
      );
      assert.equal(
        propertyStatus(item.propstats, TEST_NAMESPACE, "label"),
        200,
      );
      assert.equal(
        requiredProperty(item.propstats, TEST_NAMESPACE, "label").textContent,
        "second",
      );
    },
  );
}

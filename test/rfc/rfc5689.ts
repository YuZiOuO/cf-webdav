import assert from "node:assert/strict";
import {
  DAV_NAMESPACE,
  TEST_NAMESPACE,
  assertElement,
  assertStatus,
  childElement,
  parseDavMultiStatus,
  parseDavPropStats,
  parseXml,
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
      title: "Extended MKCOL initializes collection properties",
      prerequisites: [
        "The target is unmapped and its parent collection exists.",
      ],
      request: "MKCOL {collection}; Content-Type: application/xml; DAV:mkcol",
      assertions: [
        "The response is 201.",
        "A non-empty success body is a DAV:mkcol-response with status 200 for each property.",
        "The created collection has DAV:collection and the initialized dead property.",
      ],
      alternatives: ["A successful response body may be empty."],
    },
    async () => {
      const collection = client.newPath("extended-mkcol-success");
      const response = await client.request(collection, {
        method: "MKCOL",
        headers: { "Content-Type": "application/xml" },
        body: '<D:mkcol xmlns:D="DAV:" xmlns:T="urn:cf-r2-webdav:rfc-test"><D:set><D:prop><D:resourcetype><D:collection/></D:resourcetype><T:label>created</T:label></D:prop></D:set></D:mkcol>',
      });
      await assertStatus(response, 201);
      const body = await response.text();
      if (body.trim()) {
        const root = parseXml(body);
        assertElement(root, DAV_NAMESPACE, "mkcol-response");
        const propstats = parseDavPropStats(root);
        assert.equal(
          propertyStatus(propstats, DAV_NAMESPACE, "resourcetype"),
          200,
        );
        assert.equal(propertyStatus(propstats, TEST_NAMESPACE, "label"), 200);
      }

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
        "created",
      );
    },
  );

  rfcTest(
    {
      id: "RFC5689-03-002",
      rfc: "5689",
      section: "3, 3.3",
      requirement: "MUST",
      title: "Extended MKCOL rejects an unsupported resource type atomically",
      prerequisites: [
        "The target is unmapped and its parent collection exists.",
      ],
      request:
        "MKCOL {collection}; DAV:mkcol with an unsupported DAV:resourcetype",
      assertions: [
        "The response fails with DAV:mkcol-response.",
        "Each requested property has a non-2xx status.",
        "The collection is not created.",
      ],
      alternatives: ["RFC 5689 identifies 403 as a typical failure status."],
    },
    async () => {
      const collection = client.newPath("extended-mkcol-failure");
      const response = await client.request(collection, {
        method: "MKCOL",
        headers: { "Content-Type": "application/xml" },
        body: '<D:mkcol xmlns:D="DAV:" xmlns:T="urn:cf-r2-webdav:rfc-test"><D:set><D:prop><D:resourcetype><D:collection/><T:unsupported-resource/></D:resourcetype><T:label>not-created</T:label></D:prop></D:set></D:mkcol>',
      });
      assert.ok(
        !response.ok,
        `Unexpected successful status: ${response.status}`,
      );
      assert.match(
        response.headers.get("Content-Type") ?? "",
        /(?:application|text)\/xml/i,
        "An extended MKCOL property failure must return an XML response body",
      );
      const root = parseXml(await response.text());
      assertElement(root, DAV_NAMESPACE, "mkcol-response");
      const propstats = parseDavPropStats(root);
      assert.ok(
        (propertyStatus(propstats, DAV_NAMESPACE, "resourcetype") ?? 200) >=
          300,
        "DAV:resourcetype was not reported as a failure",
      );
      assert.ok(
        (propertyStatus(propstats, TEST_NAMESPACE, "label") ?? 200) >= 300,
        "T:label was not reported as a failure",
      );

      const absent = await client.request(collection, { method: "GET" });
      await assertStatus(absent, 404);
    },
  );
}

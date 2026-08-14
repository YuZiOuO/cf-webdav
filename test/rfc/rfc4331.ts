import assert from "node:assert/strict";
import {
  DAV_NAMESPACE,
  assertStatus,
  parseDavMultiStatus,
  propfind,
  propfindBody,
  propertyElement,
  propertyStatus,
  proppatch,
  proppatchBody,
  responseForPath,
  rfcTest,
  type WebDavTestClient,
} from "./support";

export function registerRfc4331Tests(client: WebDavTestClient) {
  rfcTest(
    {
      id: "RFC4331-03-04-001",
      rfc: "4331",
      section: "3, 4",
      requirement: "MAY",
      title:
        "Quota properties are absent for unlimited storage or valid octet counts",
      prerequisites: ["A collection exists."],
      request:
        "PROPFIND {collection}; DAV:quota-available-bytes, DAV:quota-used-bytes",
      assertions: [
        "Both properties may have status 404 for unlimited storage.",
        "Each returned property has status 200 and a non-negative decimal octet count.",
      ],
      alternatives: [
        "DAV:quota-available-bytes and DAV:quota-used-bytes may both be absent when limits are infinite.",
      ],
    },
    async () => {
      const collection = await client.createCollection("quota-values");
      const response = await propfind(
        client,
        collection,
        propfindBody("<D:quota-available-bytes/><D:quota-used-bytes/>"),
      );
      await assertStatus(response, 207);
      const item = responseForPath(
        parseDavMultiStatus(await response.text()),
        client,
        collection,
      );
      for (const name of ["quota-available-bytes", "quota-used-bytes"]) {
        const status = propertyStatus(item.propstats, DAV_NAMESPACE, name);
        if (status === 404) continue;
        assert.equal(status, 200, `Unexpected status for DAV:${name}`);
        const value = propertyElement(
          item.propstats,
          DAV_NAMESPACE,
          name,
        )?.textContent;
        assert.ok(value, `DAV:${name} has no value`);
        assert.match(
          value.trim(),
          /^\d+$/,
          `DAV:${name} is not an octet count`,
        );
      }
    },
  );

  rfcTest(
    {
      id: "RFC4331-02-001",
      rfc: "4331",
      section: "2",
      requirement: "SHOULD NOT",
      title: "DAV:allprop omits quota properties",
      prerequisites: ["A collection exists."],
      request: "PROPFIND {collection}; DAV:allprop",
      assertions: [
        "DAV:quota-available-bytes is not returned with status 200.",
        "DAV:quota-used-bytes is not returned with status 200.",
      ],
      alternatives: [
        "A server may return another non-success property status while processing the request.",
      ],
    },
    async () => {
      const collection = await client.createCollection("quota-allprop");
      const response = await propfind(
        client,
        collection,
        '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
      );
      await assertStatus(response, 207);
      const item = responseForPath(
        parseDavMultiStatus(await response.text()),
        client,
        collection,
      );
      assert.notEqual(
        propertyStatus(item.propstats, DAV_NAMESPACE, "quota-available-bytes"),
        200,
      );
      assert.notEqual(
        propertyStatus(item.propstats, DAV_NAMESPACE, "quota-used-bytes"),
        200,
      );
    },
  );

  rfcTest(
    {
      id: "RFC4331-03-04-002",
      rfc: "4331",
      section: "3, 4",
      requirement: "SHOULD",
      title: "Quota properties reject PROPPATCH as protected properties",
      prerequisites: ["A collection exists."],
      request: "PROPPATCH {collection}; DAV:set(DAV:quota-used-bytes)",
      assertions: ["DAV:quota-used-bytes is reported with status 403."],
      alternatives: [
        "The response can include a DAV:cannot-modify-protected-property precondition element.",
      ],
    },
    async () => {
      const collection = await client.createCollection("quota-protected");
      const response = await proppatch(
        client,
        collection,
        proppatchBody(
          "<D:set><D:prop><D:quota-used-bytes>1</D:quota-used-bytes></D:prop></D:set>",
        ),
      );
      await assertStatus(response, 207);
      const item = responseForPath(
        parseDavMultiStatus(await response.text()),
        client,
        collection,
      );
      assert.equal(
        propertyStatus(item.propstats, DAV_NAMESPACE, "quota-used-bytes"),
        403,
      );
    },
  );
}

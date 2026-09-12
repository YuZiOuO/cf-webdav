import assert from "node:assert/strict";
import {
  DAV_NAMESPACE,
  assertStatus,
  parseDavMultiStatus,
  propfind,
  propfindBody,
  propertyElement,
  propertyStatus,
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
      requirement: "MUST",
      title: "A collection exposes its quota usage value",
      prerequisites: ["A collection exists."],
      request:
        "PROPFIND {collection}; DAV:quota-available-bytes, DAV:quota-used-bytes",
      assertions: [
        "DAV:quota-used-bytes has status 200 and a value.",
        "DAV:quota-available-bytes may be absent for unlimited storage; when returned, it has status 200 and a value.",
        "DAV:propname lists the required DAV:quota-used-bytes property.",
      ],
      alternatives: [
        "For unlimited storage, RFC 4331 permits DAV:quota-available-bytes to have status 404.",
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
      assert.equal(
        propertyStatus(item.propstats, DAV_NAMESPACE, "quota-used-bytes"),
        200,
      );
      const usedBytes = propertyElement(
        item.propstats,
        DAV_NAMESPACE,
        "quota-used-bytes",
      )?.textContent;
      assert.ok(usedBytes?.trim(), "DAV:quota-used-bytes has no value");
      const availableStatus = propertyStatus(
        item.propstats,
        DAV_NAMESPACE,
        "quota-available-bytes",
      );
      if (availableStatus !== 404) {
        assert.equal(availableStatus, 200);
        const availableBytes = propertyElement(
          item.propstats,
          DAV_NAMESPACE,
          "quota-available-bytes",
        )?.textContent;
        assert.ok(
          availableBytes?.trim(),
          "DAV:quota-available-bytes has no value",
        );
      }

      const propname = await client.request(collection, {
        method: "PROPFIND",
        headers: { "Content-Type": "application/xml", Depth: "0" },
        body: '<D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>',
      });
      await assertStatus(propname, 207);
      const propnameItem = responseForPath(
        parseDavMultiStatus(await propname.text()),
        client,
        collection,
      );
      assert.ok(
        propertyElement(
          propnameItem.propstats,
          DAV_NAMESPACE,
          "quota-used-bytes",
        ),
        "DAV:propname does not list DAV:quota-used-bytes",
      );
    },
  );
}

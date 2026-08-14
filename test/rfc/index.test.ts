import { after, before, describe } from "node:test";
import { registerRfc4331Tests } from "./rfc4331";
import { registerRfc4918Tests } from "./rfc4918";
import { registerRfc5689Tests } from "./rfc5689";
import { registerRfc6578Tests } from "./rfc6578";
import { WebDavTestClient } from "./support";

const client = new WebDavTestClient();

before(async () => client.start());
after(async () => client.stop());

void describe("RFC 4918", () => registerRfc4918Tests(client));
void describe("RFC 6578", () => registerRfc6578Tests(client));
void describe("RFC 4331", () => registerRfc4331Tests(client));
void describe("RFC 5689", () => registerRfc5689Tests(client));

# cf-fs

[简体中文](README.zh_CN.md)

`cf-fs` is a file storage service for Cloudflare Workers built around
filesystem semantics. WebDAV and the browser interface are access layers over
the same filesystem implementation.

File contents are stored in Cloudflare R2, while coordination and metadata are
managed by Cloudflare Durable Objects.

## Architecture

The implementation is split into three layers:

- Access layers translate WebDAV and browser requests into filesystem operations.
- The filesystem layer owns paths, resources, directories, and file operations.
- The storage layer keeps metadata in Durable Objects and file contents behind
  an object-store interface, currently backed by R2.

This separation allows additional access protocols and storage backends without
duplicating filesystem semantics.

## Status

- [x] [RFC 4918](https://www.rfc-editor.org/rfc/rfc4918) — WebDAV Class 1 and Class 2
- [x] [RFC 6578](https://www.rfc-editor.org/rfc/rfc6578) — Collection Synchronization
- [x] [RFC 4331](https://www.rfc-editor.org/rfc/rfc4331) — WebDAV Quota and Size Properties
- [x] [RFC 5689](https://www.rfc-editor.org/rfc/rfc5689) — Extended MKCOL
- [ ] Atomic consistency and failure recovery across WebDAV request handling and filesystem mutations

Compatibility is validated with the [Apache Litmus](https://github.com/notroj/litmus)
WebDAV compatibility test suite. Passing Litmus does not imply complete
conformance with the listed RFCs.

## Deployment

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YuZiOuO/cf-fs)

Deploy interactively with Wrangler:

```bash
bunx cf-fs deploy
```

To remove a deployment, run the interactive destroy command. Worker deletion
requires explicit confirmation, and deleting the R2 bucket is optional.

```bash
bunx cf-fs destroy
```

<details>
<summary>Manual deployment</summary>

```bash
bun install

# Log in to Cloudflare if needed
bunx wrangler login

# Create the R2 bucket. If you use a different name, update the binding in
# wrangler.jsonc as well.
bunx wrangler r2 bucket create webdav

# Deploy the Worker. The command prints its HTTPS URL.
bun run deploy

# Set the WebDAV username and password interactively
bunx wrangler secret put USERNAME
bunx wrangler secret put PASSWORD
```

</details>

For local development, set these variables in `.dev.vars`:

```text
USERNAME=your-username
PASSWORD=your-password
```

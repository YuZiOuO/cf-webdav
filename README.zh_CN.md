# cf-fs

[English](README.md)

`cf-fs` 是运行在 Cloudflare Workers 上、以文件系统语义为核心的文件存储服务。
WebDAV 与浏览器界面是同一套文件系统实现之上的访问层。

文件内容存储在 Cloudflare R2，协调与元数据由 Cloudflare Durable Objects 管理。

## 抽象分层

实现分为三层：

- 访问层将 WebDAV 与浏览器请求转换为文件系统操作。
- 文件系统层负责路径、资源、目录及文件操作语义。
- 存储层将元数据保存在 Durable Objects 中，并通过对象存储接口保存文件内容，当前后端为 R2。

这种分层允许后续增加访问协议和存储后端，而无需重复实现文件系统语义。

## 实现状态

- [x] [RFC 4918](https://www.rfc-editor.org/rfc/rfc4918) — WebDAV Class 1 与 Class 2
- [x] [RFC 6578](https://www.rfc-editor.org/rfc/rfc6578) — 集合同步
- [x] [RFC 4331](https://www.rfc-editor.org/rfc/rfc4331) — WebDAV 配额与大小属性
- [x] [RFC 5689](https://www.rfc-editor.org/rfc/rfc5689) — 扩展 MKCOL
- [ ] WebDAV 请求处理与文件系统变更之间的原子一致性及失败恢复

通过 [Apache Litmus](https://github.com/notroj/litmus) WebDAV 兼容性测试套件
进行验证。Litmus 测试通过不代表完整符合上述 RFC 的所有要求。

## 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YuZiOuO/cf-fs)

通过 Wrangler 交互式部署：

```bash
bunx cf-fs deploy
```

如需移除部署，运行交互式销毁命令。删除 Worker 需要显式确认，是否同时删除
R2 bucket 由用户选择。

```bash
bunx cf-fs destroy
```

<details>
<summary>手动部署</summary>

```bash
bun install

# 交互式地登录 Cloudflare，如果你已登录，忽略这步
bunx wrangler login

# 创建 R2 bucket
bunx wrangler r2 bucket create webdav # 注意:如果需要使用其他名称，请同时修改 wrangler.jsonc 中的绑定。

# 部署
bun run deploy # 命令会输出 Worker 的 HTTPS 地址。

# 交互式地设定 WebDAV 用户名与密码
# 执行后马上生效
bunx wrangler secret put USERNAME
bunx wrangler secret put PASSWORD
```

</details>

本地开发时，变量从 `.dev.vars` 中读取：

```text
USERNAME=your-username
PASSWORD=your-password
```

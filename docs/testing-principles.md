# WebDAV RFC 测试原则

本文规定本项目自行编写的 WebDAV RFC 测试的规范来源、判定边界和记录要求。

## 规范范围

| RFC | 本地副本 | 官方来源 |
| --- | --- | --- |
| RFC 4918 | [`rfc/rfc4918.txt`](rfc/rfc4918.txt) | <https://www.rfc-editor.org/rfc/rfc4918> |
| RFC 6578 | [`rfc/rfc6578.txt`](rfc/rfc6578.txt) | <https://www.rfc-editor.org/rfc/rfc6578> |
| RFC 4331 | [`rfc/rfc4331.txt`](rfc/rfc4331.txt) | <https://www.rfc-editor.org/rfc/rfc4331> |
| RFC 5689 | [`rfc/rfc5689.txt`](rfc/rfc5689.txt) | <https://www.rfc-editor.org/rfc/rfc5689> |

## 原则

1. 每个测试的预期结果以适用 RFC 的具体规范性要求为依据。RFC 示例和其他实现可用于理解场景，但不构成预期结果的依据。
2. 测试通过 HTTP 请求、响应和后续 WebDAV 请求验证服务端行为。断言基于这些可观察结果，不依赖内部状态或实现方式。XML 按命名空间和结构比较，HTTP 字段名按大小写无关规则处理。
3. 适用且可观察的服务端 `MUST`、`MUST NOT` 和 `REQUIRED` 必测。`SHOULD`、`SHOULD NOT` 作为推荐项测试；偏离时必须记录理由。`MAY` 作为辅助项测试；不提供该行为是允许结果，提供时必须满足其适用的规范性约束。
4. 每项测试至少记录：稳定标识、RFC 章节、前置条件、HTTP 请求、可观察断言，以及 RFC 允许的替代结果。

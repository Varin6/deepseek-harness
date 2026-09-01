# Agent Note: web seam 的 SearXNG 搜索提供方

Status: implemented

[English](2026-08-30-web-search-searxng.md) | 中文

## 问题

[web 能力 seam](../architecture/2026-06-24-web-capability-seam.zh.md) 已交付的每个搜索后端都需要厂商凭据：Exa 与 Perplexity 需要 API 密钥，DeepSeek 原生搜索则每次搜索都消耗一个完整的辅助模型轮次、走付费端点。一个不持有上述任何凭据、并希望把下游引擎组合、隐私姿态与速率预算掌握在自己手里的部署，没有任何免密钥后端可挂载。

公共 SearXNG 实例不是可用的默认候选：大多数实例禁用 JSON API、架在机器人验证墙之后、或激进限流，且没有任何公共实例是产品可以固定的信任或可用性承诺。可行形态是部署已经在运行的那个实例。

## 决策

`@deepseek-ai/dsh-web-search-searxng`（`packages/web/web-search-searxng`）是 `ctx.web` 上的第四个搜索提供方，注册为 `searxng`。它是 Exa 适配器的形态但不带凭据：SearXNG 实例 JSON API（`GET /search?q=<query>&format=json`）之上的薄客户端，`redirect: 'error'` 的原生 `fetch`，`WEB_ABORTED`/`WEB_PROVIDER_ERROR` 映射，以及 seam 的 `maxResults` 截断作为唯一的结果数强制执行（SearXNG JSON API 没有数量参数）。

映射规则，每条都对照 seam 的"绝不虚构"纪律做出选择：

- 来源的 `snippet` 只来自实例的 `content` 摘要；没有摘要的来源被**保留**（URL 与标题仍可供引用）而非丢弃，不同于 Exa 的高亮规则。
- 实例的直接 `answers[]` 并入结果的 `content`；空白与非字符串条目被丢弃。
- URL 不是绝对 HTTP(S) URL 的结果被丢弃。
- `available()` 只做本地端点解析——没有凭据可检查，也不做存活探测。

配置只有一个字段：`baseURL`（config → `$SEARXNG_BASE_URL` → `http://127.0.0.1:8080`，即 docker 快速入门端口）。基础 bundle 以**禁用**状态交付该行：没有可达的启用 JSON 的实例时挂载它只会把配置错误变成执行时错误；而 DeepSeek 搜索已被固定为 `web.searchProvider`，自动启用的 `searxng` 也永远不会赢得选择。拥有实例的部署在后续补丁层启用该行并固定 `searchProvider: searxng`。

非 2xx 的提供方消息会指明已配置的端点与两个配置旋钮（`SEARXNG_BASE_URL`、`web-search-searxng.baseURL`），并把端点选择留给用户——与 DeepSeek 提供方消息相同的指引形态。

## 曾考虑的替代方案

**以公共 SearXNG 实例作为默认端点。** 被否决，因为 JSON 格式可用性、机器人验证墙与限流使公共实例成为不可靠的默认值，产品将为一个自己无法修复的免费特性依赖第三方的可用性。

**为没有 JSON 的实例提供 HTML 抓取回退。** 被否决：seam 的提供方纪律是结构化结果，绝不是散文抓取，否则默认配置实例的 HTML 响应会冒充数据。

**在 DeepSeek 卡片旁边加一个设置页卡片。** 推迟：设置卡片家族渲染携带凭据的提供方；SearXNG 唯一的非密字段已由 config/env 完整覆盖，Plugins 页清单也会展示该行。

## 后果

免密钥搜索是一个部署叠加层，而非交付默认：基础 bundle 的行保持禁用，DeepSeek 固定不受影响，`web_search` 在每种模式下保留其稳定 schema。部署启用该行、把 `baseURL` 指向其实例（或设置 `SEARXNG_BASE_URL`）、启用实例的 `json` 格式、并固定 `searchProvider: searxng`；提供方特定失败经 `WEB_PROVIDER_ERROR` 以指明端点的消息呈现。单元与集成测试覆盖映射、错误与中止分类、经真实 HTTP 的重定向回归、HMR 安全处置与端到端工具路径；e2e 套件在没有 `$SEARXNG_BASE_URL` 时自动跳过。

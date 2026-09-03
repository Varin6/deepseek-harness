---
description: "ctx.web 的 SearXNG 搜索提供方：部署方如何挂载通过自托管 SearXNG 实例（启用 JSON API）实现的免密钥 web 搜索。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-searxng

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-searxng`，harness 可以通过部署方运行的 SearXNG 实例搜索 web，无需任何 API 密钥即可获得可移植摘要与发布日期。当部署不持有搜索厂商凭据时选择它——SearXNG 免密钥，其结果来自实例配置的下游引擎。摘要映射为 `snippet`，实例的直接 `answers[]` 映射为 `content`；没有摘要的来源会被保留而非丢弃。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `searxng` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: searxng` 固定。

### 何时选择

当部署运行一个 SearXNG 实例（或指向一个可信实例）、并希望基于实例下游引擎做免密钥搜索时选择此后端。SearXNG 只有在其设置启用 JSON 格式时才应答 `format=json`，因此实例就是部署的配置面：提供方在端点可解析时即可用；不服务 JSON 的实例——默认配置、机器人验证墙或限流——会在执行时以结构化错误使调用失败。

### 最小配置

加载 web 服务与本提供方；端点回退到启动环境中的 `$SEARXNG_BASE_URL`，再回退到本地 docker 快速入门端口。不读取也不需要任何凭据。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: http://10.0.0.5:8080
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `$SEARXNG_BASE_URL`，否则 `http://127.0.0.1:8080` | SearXNG 端点基址；追加 `/search`。无法解析时提供方不可用 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-searxng)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索返回什么

每项 SearXNG 结果映射为 `WebSearchSource`：`url`、`title`、以 `content` 作为 `snippet`、`publishedAt`；没有摘要的结果不携带 `snippet` 而非被丢弃，因为 URL 与标题仍可供引用。实例的直接 `answers[]` 会并入结果的 `content`。SearXNG 没有线上结果数控制项，因此 seam 在返回路径上按请求的 `maxResults` 截断并标记结果。

### 失败与恢复

提供方失败——HTTP 错误（包括实例的机器人验证墙与限流）、网络失败、响应体无法解析或结构不符——以 `WebError` `WEB_PROVIDER_ERROR` 呈现，其消息会指明已配置的端点与配置旋钮；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。调用方按 code 路由；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 SearXNG 实例 JSON API 之上的薄适配器，遵循三条刻意的规则：

- **构造上免密钥。** SearXNG 不携带凭据，因此提供方不读取任何凭据；实例就是部署的信任边界，可用性检查是本地端点解析而非存活探测。
- **摘要而非虚构 snippet。** 来源只有在实例的 `content` 摘要存在时才获得 `snippet`；没有摘要的来源不带占位符保留，而非丢弃。
- **直接答案即 content。** 实例的 `answers[]` 是引擎给出的直接答案（定义、计算）；它们映射为结果的 `content`，空白或非字符串条目会被丢弃。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `SearxngSearchProvider`：请求分发、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | SearXNG 协议类型：`SearxngSearchResponse`、`SearxngResult` |
| — | 不发布运行时不变式伴生入口；约定在服务处强制执行。 |

### 请求与映射流程

`search()` 以 URL 编码的查询与 `format=json`、`redirect: 'error'` GET `{baseURL}/search`，因此重定向会在不接触目标的情况下使请求失败。解析后的 `results[]` 逐项映射（URL 不是绝对 HTTP(S) URL 的条目被丢弃），`answers[]` 并入 `content`；服务在返回路径上应用最终的 `maxResults` 上限。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余情况变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——七包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-searxng)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-web`：该工具把本提供方经 `maxResults` 限制的 URL、标题、摘要与发布日期，或将确切的错误消息 `SearXNG search aborted`、`SearXNG search request failed: <error>` 和 `SearXNG returned an unprocessable response body: <error>` 保留在消费方的错误包装层内。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **实例必须启用 JSON 格式**——默认配置的 SearXNG 实例对 `format=json` 应答 HTML 或 403，失败会在执行时而非加载时以 `WEB_PROVIDER_ERROR` 呈现。
- **不探测实例存活**——`available()` 是本地端点解析；已停止或路由错误的实例会在执行时使调用失败。
- **没有线上结果数控制项**——SearXNG 的 JSON API 不携带数量参数，因此 `maxResults` 只由服务截断事后强制执行。
- **按错误形状分类中止**——只有名为 `AbortError` 的 `DOMException` 才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）呈现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：实例控制项与发现机制

自托管 SearXNG 还公开了 categories、language、time-range 与 safe-search 控制项，部署也可能希望以实例发现替代固定端点。两者都等待提供方无关的服务字段，让家族以一个协调一致的控制项、而非厂商专有参数的方式新增。

</details>

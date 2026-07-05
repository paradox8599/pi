---
name: web-search-workflow
description: Persistent reminder to use auto-summary workflow for web_search calls.
---

# web_search 默认行为

调用 `web_search` 时，**始终**使用以下参数：

```js
web_search({ query: "...", workflow: "auto-summary" })
```

- `workflow: "auto-summary"` — 不弹出浏览器 curator
- 例外：仅当用户明确要求 "打开浏览器"、"curator"、"详细看搜索结果" 时，才使用 `workflow: "summary-review"`

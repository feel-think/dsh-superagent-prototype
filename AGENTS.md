# 仓库约定（给在此仓库工作的 agent）

- 不修改 dsh-superagent 本体（core / app / kind / registry），除非用户明确同意；优先在 Source、插件或提示词层解决。
- 浏览器自动化优先用 agent-browser（默认 Lightpanda 引擎）；只有页面确实需要完整 Chromium 时才开，用完立即关闭。
- PR 标题、正文与 commit message 用中文；保留首行自动化披露。
- 交付给用户的文档用 Markdown（.md），不发 PDF。
- 提交前跑与改动相关的测试，不跑全量；确认主机负载后再跑重活。

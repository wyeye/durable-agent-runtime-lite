# Fullstack I18n Contract

当前版本只开放 `zh-CN`，但前后端已经通过 `packages/i18n` 共享同一份翻译资源和 Locale Contract。不要创建空的英文资源文件来伪装多语言完成。

## Locale

- `SupportedLocale` 当前只有 `zh-CN`。
- `zh`、`zh_CN` 和大小写差异会归一化为 `zh-CN`。
- 不支持的 `Accept-Language` 会安全回退到 `zh-CN`。
- API 响应设置 `Content-Language: zh-CN` 和 `Vary: Accept-Language`。

## API、日志和审计

- API 响应保留稳定 `code`、`message_key` 和机器字段，`message` 按请求 locale 渲染。
- 运行日志使用部署级 `LOG_LOCALE=zh-CN`，不会随单个请求切换语言。
- Audit 的事实源是 `event_type`、`message_key` 和 `message_params`；`display_message` 只是当前 UI locale 的展示结果。

## 前端

- control-plane 第一版不显示语言切换器。
- 页面标题、按钮、表头、表单提示、状态标签和主要错误文案使用中文。
- `task_run_id`、`workflow_id`、`dataset_hash`、API path、JSON 字段名、enum 值、tool name、model id 等机器字段不翻译。

## 校验

```bash
corepack pnpm i18n:check
```

该脚本检查 `zh-CN` 资源非空、错误/日志/审计 key 完整、翻译可解析，以及 control-plane 页面显著英文 UI 文案残留。

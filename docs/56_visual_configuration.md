# Visual Configuration

CP-VISUAL-CONFIG-1 将 control-plane 的可写配置入口从可编辑 JSON 改为结构化表单。后端 API、数据库、Contract、Registry 生命周期和 Evaluation 生命周期保持不变。

## Architecture

编辑链路固定为：

```text
existing spec -> specToForm() -> Visual Editor -> formToSpec() -> @dar/contracts Zod safeParse() -> existing API
```

`apps/control-plane/src/web/visual-config/` 提供通用能力：

- `VisualEditorAdapter`：每种资源的 `schema`、`createDefault`、`specToForm`、`formToSpec` 和预览对象。
- `ReadonlyJsonPreview`：只读 canonical JSON、复制、下载、行号和对象大小。
- `ExactVersionSelect`：通过现有 list/version API 选择精确版本，不使用 `latest`，不自动选择第一项。
- `StringListEditor`：逐项编辑、去重、上移、下移和按行批量粘贴。
- `StructuredValueEditor`：树形编辑标准 JSON 值，不暴露 raw JSON 文本输入。
- `JsonSchemaBuilder`：编辑常用 JSON Schema 子集。

## Supported Resources

Registry 可视化编辑覆盖：

- Flow
- Route
- Tool
- Agent
- ModelPolicy
- Prompt
- TenantRuntimePolicy

Evaluation 可视化编辑覆盖：

- Evaluation Dataset
- Evaluation Case
- Evaluation Gate Policy

## Flow Semantics

Flow 可视化编排只表达现有 `steps` 数组的顺序执行：

```text
开始 -> Step 1 -> Step 2 -> ... -> 结束
```

React Flow canvas 只用于展示顺序，不保存节点坐标，不创建任意 DAG、循环边或后端不支持的新字段。Condition Step 的 `when` 仍是步骤条件，不是图分支语义。

## JSON Is Read-Only

JSON 只作为查看和审查视图存在：

- 可以复制。
- 可以下载 `.json`。
- 可以显示当前表单将提交的对象。
- 不提供编辑、导入、应用 JSON 或保存 JSON。

保留的 `JsonEditor` 组件只是只读包装，不能作为可写配置入口。

## JSON Schema Builder

第一版支持：

```text
type, title, description, properties, required, items, enum, default,
minimum, maximum, minLength, maxLength, minItems, maxItems,
additionalProperties:boolean
```

已存在但第一版不直接编辑的关键字会保留并显示高级字段提示，例如：

```text
oneOf, anyOf, allOf, $ref, patternProperties, if/then/else
```

保存时会把支持字段与原始高级字段合并，避免静默丢失合法 Contract 字段。

## Exact References

引用字段必须通过精确版本选择器或结构化字段生成，不能手写 `latest` 或自动回退到第一项。Gate Policy 的 Required Dataset 选择会从已发布 Dataset 版本读取 `dataset_hash`，用户不能手工伪造 hash。

## Round-Trip

每种支持资源都有 round-trip 测试：

```text
schema.parse(formToSpec(specToForm(schema.parse(fixture))))
```

canonical 结果必须与 fixture 等价。允许移除的仅限顶层服务端管理字段，例如 `status`、`revision`、`sha256`、创建/更新时间和发布人。

## Permissions

前端仍沿用现有 RBAC：

- `auditor` 只读。
- `capability_operator` 可编辑允许的 draft/validated 资源。
- `platform_admin` 保持发布治理能力。

前端隐藏按钮不替代后端 401/403/409/422 校验。

## Smoke

`smoke:control-plane-ui-e2e` 和 `smoke:evaluation-ui-e2e` 不再驱动 `json-editor-textarea` 创建当前可写配置。它们通过可视化表单创建核心 Registry、Dataset、Case 和 Gate Policy 对象，再通过现有 API 读取 exact id/version/hash 证据。

## AR-2B Final Gate

AR-2B-FINAL-GATE 未改变可视化配置的编辑边界：Registry、Evaluation Dataset、Evaluation Case 和 Evaluation Gate Policy 仍通过结构化表单写入，JSON 仍只读。真实 Ollama Evaluation gate 只验证运行时链路、Evidence、Scoring 和 Gate Decision，不新增可写 JSON 入口、不改变前端国际化、不改变 Dataset/Case/Gate Policy CRUD。

## Limits

第一版不包含：

- 任意 DAG Flow 设计器。
- Raw JSON 高级编辑模式。
- JSON 导入或上传替代表单。
- 新后端 Contract、API、DB migration 或运行时语义。
- 新通用表单框架。

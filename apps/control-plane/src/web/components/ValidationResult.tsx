import type { RegistryValidationResult } from '@dar/contracts';
import { Alert, Collapse, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';

const issueColumns: ColumnsType<RegistryValidationResult['errors'][number]> = [
  { title: '级别', dataIndex: 'severity', key: 'severity', render: (value: string) => <Tag color={value === 'error' ? 'red' : 'gold'}>{value === 'error' ? '错误' : '警告'}</Tag> },
  { title: '错误码', dataIndex: 'code', key: 'code' },
  { title: '路径', dataIndex: 'path', key: 'path', render: (value: string | undefined) => value ?? '-' },
  { title: '说明', dataIndex: 'message', key: 'message' },
];

export function ValidationResult({ result }: { result: RegistryValidationResult | undefined }) {
  if (!result) {
    return <Alert type="info" showIcon message="尚未执行校验" />;
  }

  const issues = [...result.errors, ...result.warnings];
  return (
    <Collapse
      defaultActiveKey={['summary']}
      items={[
        {
          key: 'summary',
          label: '校验结果',
          children: (
            <>
              <Alert
                type={result.valid && result.can_publish ? 'success' : 'warning'}
                showIcon
                message={result.can_publish ? '可以发布' : '暂不可发布'}
                description={`错误：${result.errors.length}，警告：${result.warnings.length}`}
              />
              <Table
                size="small"
                rowKey={(row) => `${row.severity}-${row.code}-${row.path ?? row.message}`}
                columns={issueColumns}
                dataSource={issues}
                pagination={false}
                style={{ marginTop: 12 }}
              />
            </>
          ),
        },
        {
          key: 'graph',
          label: `依赖图（${result.dependency_graph.nodes.length} 个节点 / ${result.dependency_graph.edges.length} 条边）`,
          children: (
            <pre className="cp-json-pre">{JSON.stringify(result.dependency_graph, null, 2)}</pre>
          ),
        },
      ]}
    />
  );
}

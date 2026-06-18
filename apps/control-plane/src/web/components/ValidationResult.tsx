import type { RegistryValidationResult } from '@dar/contracts';
import { Alert, Collapse, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';

const issueColumns: ColumnsType<RegistryValidationResult['errors'][number]> = [
  { title: 'severity', dataIndex: 'severity', key: 'severity', render: (value: string) => <Tag color={value === 'error' ? 'red' : 'gold'}>{value}</Tag> },
  { title: 'code', dataIndex: 'code', key: 'code' },
  { title: 'path', dataIndex: 'path', key: 'path', render: (value: string | undefined) => value ?? '-' },
  { title: 'message', dataIndex: 'message', key: 'message' },
];

export function ValidationResult({ result }: { result: RegistryValidationResult | undefined }) {
  if (!result) {
    return <Alert type="info" showIcon message="尚未执行 validate" />;
  }

  const issues = [...result.errors, ...result.warnings];
  return (
    <Collapse
      defaultActiveKey={['summary']}
      items={[
        {
          key: 'summary',
          label: 'Validation Result',
          children: (
            <>
              <Alert
                type={result.valid && result.can_publish ? 'success' : 'warning'}
                showIcon
                message={result.can_publish ? '可以发布' : '暂不可发布'}
                description={`errors: ${result.errors.length}, warnings: ${result.warnings.length}`}
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
          label: `Dependency Graph (${result.dependency_graph.nodes.length} nodes / ${result.dependency_graph.edges.length} edges)`,
          children: (
            <pre className="cp-json-pre">{JSON.stringify(result.dependency_graph, null, 2)}</pre>
          ),
        },
      ]}
    />
  );
}

import type { ToolRiskLevel } from '@dar/contracts';
import { Alert, Tag } from 'antd';

const colors: Record<ToolRiskLevel, string> = {
  L0: 'green',
  L1: 'blue',
  L2: 'gold',
  L3: 'orange',
  L4: 'red',
};

export function RiskTag({ risk }: { risk: ToolRiskLevel | string | undefined }) {
  if (!risk) {
    return <Tag>unknown</Tag>;
  }
  return <Tag color={isRisk(risk) ? colors[risk] : 'default'}>{risk}</Tag>;
}

export function RiskNotice({ risk, sideEffect }: { risk: ToolRiskLevel | string | undefined; sideEffect?: boolean }) {
  if (risk === 'L3') {
    return (
      <Alert
        type="warning"
        showIcon
        message="L3 工具需要 Human Task 确认路径"
        description={sideEffect ? '该工具存在副作用，发布前应确认 require_human_confirm 或 preview/commit 路径已配置。' : '校验服务会继续检查确认路径。'}
      />
    );
  }
  if (risk === 'L4') {
    return (
      <Alert
        type="error"
        showIcon
        message="L4 工具默认禁止自动执行"
        description="本阶段仅展示和治理 L4 manifest，不实现自动执行或真实凭据管理。"
      />
    );
  }
  return null;
}

function isRisk(value: string): value is ToolRiskLevel {
  return ['L0', 'L1', 'L2', 'L3', 'L4'].includes(value);
}

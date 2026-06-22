import type { ZodIssue } from 'zod';
import { Alert, Button, List } from 'antd';
import { useTranslation } from 'react-i18next';
import { issuePath, type VisualFormIssue } from '../form-error-mapper.js';

export function FormErrorSummary({
  issues = [],
  apiIssues = [],
}: {
  issues?: ZodIssue[];
  apiIssues?: VisualFormIssue[];
}) {
  const { t } = useTranslation();
  const items: VisualFormIssue[] = [
    ...issues.map((issue) => ({
      path: issuePath(issue),
      message: issue.message,
    })),
    ...apiIssues,
  ];
  if (!items.length) {
    return null;
  }
  return (
    <Alert
      type="error"
      showIcon
      message={t('visualConfig.validation.summaryTitle')}
      description={
        <List
          size="small"
          dataSource={items}
          renderItem={(issue) => (
            <List.Item>
              <Button
                type="link"
                size="small"
                onClick={() => focusField(issue.path)}
              >
                {fieldLabel(issue.path)}
              </Button>
              {issue.code ? `${issue.code}：` : null}
              {issue.message}
            </List.Item>
          )}
        />
      }
    />
  );
}

function focusField(path: string): void {
  const field = document.querySelector<HTMLElement>(`[data-field-path="${CSS.escape(path)}"]`);
  field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  field?.focus();
}

function fieldLabel(path: string): string {
  return path === 'root' ? '配置对象' : path;
}

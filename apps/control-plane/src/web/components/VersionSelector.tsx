import { Select } from 'antd';
import type { RegistryRecord } from '../api/registry-api.js';
import { StatusTag } from './StatusTag.js';

export function VersionSelector({
  versions,
  value,
  onChange,
  placeholder = '选择版本',
}: {
  versions: RegistryRecord[];
  value: number | undefined;
  onChange(value: number): void;
  placeholder?: string;
}) {
  return (
    <Select
      style={{ minWidth: 160 }}
      placeholder={placeholder}
      value={value ?? null}
      onChange={onChange}
      options={versions.map((record) => ({
        value: record.version,
        label: (
          <span>
            v{record.version} <StatusTag status={record.status} />
          </span>
        ),
      }))}
    />
  );
}

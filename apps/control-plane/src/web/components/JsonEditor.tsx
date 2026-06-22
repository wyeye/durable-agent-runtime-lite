import { ReadonlyJsonPreview } from '../visual-config/components/ReadonlyJsonPreview.js';

export function JsonEditor({
  value,
  filename = 'readonly-json.json',
}: {
  value: string;
  filename?: string;
}) {
  return <ReadonlyJsonPreview value={safeParse(value)} filename={filename} />;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { raw_text: value };
  }
}

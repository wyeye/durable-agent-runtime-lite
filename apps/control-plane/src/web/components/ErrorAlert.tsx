import { Alert } from 'antd';
import { stringifyPretty } from '../utils/json.js';
import { toFriendlyError } from '../utils/errors.js';

export function ErrorAlert({ error }: { error: unknown }) {
  const friendly = toFriendlyError(error);
  return (
    <Alert
      type="error"
      showIcon
      message={friendly.title}
      description={
        <div>
          <div>{friendly.description}</div>
          {friendly.code ? <div>错误码：{friendly.code}</div> : null}
          {friendly.status ? <div>HTTP：{friendly.status}</div> : null}
          {friendly.details ? <pre className="cp-json-pre">{stringifyPretty(friendly.details)}</pre> : null}
        </div>
      }
    />
  );
}

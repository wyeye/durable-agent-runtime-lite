import { Alert, Modal } from 'antd';
import { useEffect, useRef } from 'react';
import { stringifyPretty } from '../utils/json.js';
import { toFriendlyError } from '../utils/errors.js';

export function ErrorAlert({ error }: { error: unknown }) {
  const friendly = toFriendlyError(error);
  const shownKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const modal = friendly.validationModal;
    if (!modal) {
      shownKeyRef.current = undefined;
      return;
    }
    const nextKey = `${friendly.code ?? 'validation'}:${friendly.description}:${modal.issues.join('|')}`;
    if (shownKeyRef.current === nextKey) {
      return;
    }
    shownKeyRef.current = nextKey;
    Modal.error({
      title: modal.title,
      content: (
        <div>
          <div>{modal.description}</div>
          <ul>
            {modal.issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      ),
      okText: '知道了',
      width: 720,
    });
  }, [friendly]);

  if (friendly.validationModal) {
    return null;
  }

  return (
    <Alert
      type="error"
      showIcon
      message={friendly.title}
      description={
        <div>
          <div>{friendly.description}</div>
          {friendly.validationIssues?.length ? (
            <ul>
              {friendly.validationIssues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          ) : null}
          {friendly.code ? <div>错误码：{friendly.code}</div> : null}
          {friendly.status ? <div>HTTP：{friendly.status}</div> : null}
          {friendly.details ? <pre className="cp-json-pre">{stringifyPretty(friendly.details)}</pre> : null}
        </div>
      }
    />
  );
}

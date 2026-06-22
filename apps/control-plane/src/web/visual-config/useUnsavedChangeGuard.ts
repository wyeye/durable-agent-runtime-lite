import { useEffect } from 'react';
import { useBeforeUnload, useBlocker } from 'react-router';

export function useUnsavedChangeGuard(when: boolean, message: string): void {
  const blocker = useBlocker(when);

  useBeforeUnload((event) => {
    if (!when) {
      return;
    }
    event.preventDefault();
    event.returnValue = message;
  });

  useEffect(() => {
    if (blocker.state !== 'blocked') {
      return;
    }
    if (globalThis.confirm(message)) {
      blocker.proceed();
      return;
    }
    blocker.reset();
  }, [blocker, message]);
}

import { Navigate, Outlet, useLocation } from 'react-router';
import { useIdentity } from './identity-context.js';

export function RequireIdentity() {
  const { identity } = useIdentity();
  const location = useLocation();

  if (!identity) {
    const next = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login${next && next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`} replace />;
  }

  return <Outlet />;
}

export function RedirectIfAuthenticated() {
  const { identity } = useIdentity();
  const location = useLocation();

  if (identity) {
    const params = new URLSearchParams(location.search);
    const next = params.get('next');
    return <Navigate to={next && next.startsWith('/') ? next : '/chat'} replace />;
  }

  return <Outlet />;
}

import React, { createContext, useContext, useMemo, useState } from 'react';
import type { ControlPlanePermission } from '@dar/security';
import { hasControlPlanePermission } from '@dar/security';
import type { IamResolvedIdentity } from '@dar/contracts';

export interface ControlPlaneIdentity {
  user_id: string;
  tenant_id: string;
  roles: string[];
  membership_roles?: string[];
  platform_roles?: string[];
}

interface IdentityContextValue {
  identity: ControlPlaneIdentity | undefined;
  setIdentity(identity: ControlPlaneIdentity | undefined): void;
  clearIdentity(): void;
  hasPermission(permission: ControlPlanePermission): boolean;
  canUseRuntime: boolean;
}

const storageKey = 'dar.control-plane.identity';
const IdentityContext = createContext<IdentityContextValue | undefined>(undefined);

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const [identity, setStoredIdentity] = useState<ControlPlaneIdentity | undefined>(() => readStoredIdentity());

  const value = useMemo<IdentityContextValue>(() => ({
    identity,
    setIdentity: (next) => {
      setStoredIdentity(next);
      if (next) {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } else {
        localStorage.removeItem(storageKey);
      }
    },
    clearIdentity: () => {
      setStoredIdentity(undefined);
      localStorage.removeItem(storageKey);
    },
    hasPermission: (permission) => identity ? hasControlPlanePermission(identity, permission) : false,
    canUseRuntime: Boolean(identity),
  }), [identity]);

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): IdentityContextValue {
  const context = useContext(IdentityContext);
  if (!context) {
    throw new Error('useIdentity must be used within IdentityProvider');
  }
  return context;
}

export function readStoredIdentity(): ControlPlaneIdentity | undefined {
  const fromStorage = safeReadLocalStorage();
  if (fromStorage) {
    return fromStorage;
  }
  return undefined;
}

function safeReadLocalStorage(): ControlPlaneIdentity | undefined {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as unknown;
    return parseIdentity(parsed);
  } catch {
    return undefined;
  }
}

function parseIdentity(value: unknown): ControlPlaneIdentity | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.user_id !== 'string' || typeof record.tenant_id !== 'string') {
    return undefined;
  }
  const roles = Array.isArray(record.roles)
    ? record.roles.filter((role): role is string => typeof role === 'string' && role.length > 0)
    : [];
  const membershipRoles = Array.isArray(record.membership_roles)
    ? record.membership_roles.filter((role): role is string => typeof role === 'string')
    : [];
  const platformRoles = Array.isArray(record.platform_roles)
    ? record.platform_roles.filter((role): role is string => typeof role === 'string')
    : [];
  return {
    user_id: record.user_id,
    tenant_id: record.tenant_id,
    roles,
    membership_roles: membershipRoles,
    platform_roles: platformRoles,
  };
}

export function fromResolvedIdentity(identity: IamResolvedIdentity): ControlPlaneIdentity {
  return {
    user_id: identity.user_id,
    tenant_id: identity.tenant_id,
    roles: identity.roles,
    membership_roles: identity.membership_roles,
    platform_roles: identity.platform_roles,
  };
}

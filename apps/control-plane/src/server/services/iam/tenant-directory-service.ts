import type {
  IamTenant,
  IamTenantCreateRequest,
  IamTenantUpdateRequest,
  IamTenantQuery,
} from '@dar/contracts';
import type { TenantRepository } from '@dar/db';

export interface TenantDirectoryAuditWriter {
  write(event: {
    tenant_id: string;
    actor_id: string;
    action: string;
    target_type: string;
    target_id: string;
    result: string;
    payload?: Record<string, unknown> | undefined;
    request_id?: string | undefined;
  }): Promise<void>;
}

export class TenantDirectoryService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly audit: TenantDirectoryAuditWriter,
  ) {}

  async list(query: IamTenantQuery): Promise<{ items: IamTenant[]; total: number }> {
    return this.repo.list(query);
  }

  async get(tenantId: string): Promise<IamTenant> {
    const tenant = await this.repo.get(tenantId);
    if (!tenant) {
      throw new Error(`IAM_TENANT_NOT_FOUND: ${tenantId}`);
    }
    return tenant;
  }

  async create(input: IamTenantCreateRequest, operatorId: string, requestId?: string): Promise<IamTenant> {
    const tenant = await this.repo.create(input, operatorId);
    await this.audit.write({
      tenant_id: tenant.tenant_id,
      actor_id: operatorId,
      action: 'iam.tenant.created',
      target_type: 'tenant',
      target_id: tenant.tenant_id,
      result: 'succeeded',
      payload: { display_name: tenant.display_name },
      request_id: requestId,
    });
    return tenant;
  }

  async update(tenantId: string, input: IamTenantUpdateRequest, operatorId: string, requestId?: string): Promise<IamTenant> {
    const tenant = await this.repo.update(tenantId, input, operatorId);
    await this.audit.write({
      tenant_id: tenantId,
      actor_id: operatorId,
      action: 'iam.tenant.updated',
      target_type: 'tenant',
      target_id: tenantId,
      result: 'succeeded',
      payload: { revision: tenant.revision },
      request_id: requestId,
    });
    return tenant;
  }

  async activate(tenantId: string, operatorId: string, requestId?: string): Promise<IamTenant> {
    const tenant = await this.repo.setStatus(tenantId, 'active', operatorId);
    await this.audit.write({
      tenant_id: tenantId,
      actor_id: operatorId,
      action: 'iam.tenant.activated',
      target_type: 'tenant',
      target_id: tenantId,
      result: 'succeeded',
      request_id: requestId,
    });
    return tenant;
  }

  async disable(tenantId: string, operatorId: string, requestId?: string): Promise<IamTenant> {
    const tenant = await this.repo.setStatus(tenantId, 'disabled', operatorId);
    await this.audit.write({
      tenant_id: tenantId,
      actor_id: operatorId,
      action: 'iam.tenant.disabled',
      target_type: 'tenant',
      target_id: tenantId,
      result: 'succeeded',
      request_id: requestId,
    });
    return tenant;
  }
}

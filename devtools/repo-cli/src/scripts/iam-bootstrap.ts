/**
 * IAM Bootstrap Admin - Creates or ensures a platform admin user exists.
 *
 * Usage:
 *   tsx devtools/repo-cli/src/scripts/iam-bootstrap.ts [--user-id <id>] [--display-name <name>] [--email <email>]
 */
import { loadConfig } from '@dar/config';
import { createDb, closeDb, TenantRepository, UserAccountRepository, TenantMembershipRepository, AuditEventRepository } from '@dar/db';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const userId = getArg(args, '--user-id') ?? 'platform_admin';
  const displayName = getArg(args, '--display-name') ?? '平台管理员';
  const email = getArg(args, '--email') ?? undefined;
  const tenantId = 'platform';

  const config = loadConfig();
  const db = createDb({ databaseUrl: config.DATABASE_URL });

  try {
    const tenantRepo = new TenantRepository(db);
    const userRepo = new UserAccountRepository(db);
    const membershipRepo = new TenantMembershipRepository(db);
    const auditRepo = new AuditEventRepository(db);

    // 1. Ensure system management tenant exists
    let tenant = await tenantRepo.get(tenantId);
    if (!tenant) {
      tenant = await tenantRepo.create({ tenant_id: tenantId, display_name: '平台管理', description: '系统管理租户' }, 'system:bootstrap');
      console.log(`[bootstrap] Created tenant: ${tenantId}`);
    } else {
      console.log(`[bootstrap] Tenant already exists: ${tenantId}`);
    }

    // 2. Ensure admin user exists
    let user = await userRepo.get(userId);
    if (!user) {
      user = await userRepo.create({
        user_id: userId,
        display_name: displayName,
        ...(email ? { email } : {}),
        platform_roles: ['platform_admin'],
      }, 'system:bootstrap');
      console.log(`[bootstrap] Created user: ${userId} with platform_admin role`);
    } else {
      // Ensure platform_admin role
      if (!user.platform_roles.includes('platform_admin')) {
        user = await userRepo.update(userId, {
          platform_roles: ['platform_admin'],
          expected_revision: user.revision,
        }, 'system:bootstrap');
        console.log(`[bootstrap] Added platform_admin role to user: ${userId}`);
      } else {
        console.log(`[bootstrap] User already exists: ${userId} (platform_admin)`);
      }
    }

    // 3. Ensure membership in platform tenant
    let membership = await membershipRepo.get(tenantId, userId);
    if (!membership) {
      membership = await membershipRepo.create({ tenant_id: tenantId, user_id: userId, roles: [] }, 'system:bootstrap');
      console.log(`[bootstrap] Created membership: ${userId} -> ${tenantId}`);
    } else {
      console.log(`[bootstrap] Membership already exists: ${userId} -> ${tenantId}`);
    }

    // 4. Write audit event
    await auditRepo.append({
      tenant_id: '*',
      actor_id: 'system:bootstrap',
      action: 'iam.bootstrap.admin',
      target_type: 'user',
      target_id: userId,
      result: 'succeeded',
      payload: { platform_roles: user.platform_roles },
      event_key: `iam.bootstrap.admin:${userId}:${Date.now()}`,
    }).catch(() => {
      // Audit write failure is non-fatal for bootstrap
    });

    console.log('[bootstrap] IAM bootstrap completed successfully.');
  } finally {
    await closeDb(db);
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

main().catch((error) => {
  console.error('[bootstrap] Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

/**
 * IAM Local Seed - Creates development tenant, users, and memberships.
 *
 * Usage:
 *   tsx devtools/repo-cli/src/scripts/iam-seed-local.ts
 */
import { loadConfig } from '@dar/config';
import { createDb, closeDb, TenantRepository, UserAccountRepository, TenantMembershipRepository } from '@dar/db';

interface SeedUser {
  user_id: string;
  display_name: string;
  email?: string;
  platform_roles: string[];
  membership_roles: string[];
}

const SEED_TENANT_ID = 'development';

const SEED_USERS: SeedUser[] = [
  { user_id: 'dev_admin', display_name: '开发管理员', email: 'dev-admin@example.com', platform_roles: ['platform_admin'], membership_roles: [] },
  { user_id: 'dev_operator', display_name: '开发运营员', email: 'dev-operator@example.com', platform_roles: [], membership_roles: ['capability_operator'] },
  { user_id: 'dev_auditor', display_name: '开发审计员', email: 'dev-auditor@example.com', platform_roles: [], membership_roles: ['auditor'] },
  { user_id: 'dev_member', display_name: '开发普通成员', email: 'dev-member@example.com', platform_roles: [], membership_roles: [] },
];

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb({ databaseUrl: config.DATABASE_URL });

  try {
    const tenantRepo = new TenantRepository(db);
    const userRepo = new UserAccountRepository(db);
    const membershipRepo = new TenantMembershipRepository(db);

    // 1. Ensure development tenant
    let tenant = await tenantRepo.get(SEED_TENANT_ID);
    if (!tenant) {
      tenant = await tenantRepo.create({ tenant_id: SEED_TENANT_ID, display_name: '开发环境', description: '本地开发租户' }, 'system:seed');
      console.log(`[seed] Created tenant: ${SEED_TENANT_ID}`);
    } else {
      console.log(`[seed] Tenant already exists: ${SEED_TENANT_ID}`);
    }

    // 2. Ensure each user
    for (const seedUser of SEED_USERS) {
      let user = await userRepo.get(seedUser.user_id);
      if (!user) {
        user = await userRepo.create({
          user_id: seedUser.user_id,
          display_name: seedUser.display_name,
          ...(seedUser.email ? { email: seedUser.email } : {}),
          platform_roles: seedUser.platform_roles as ['platform_admin'],
        }, 'system:seed');
        console.log(`[seed] Created user: ${seedUser.user_id}`);
      } else {
        console.log(`[seed] User already exists: ${seedUser.user_id}`);
      }

      // 3. Ensure membership
      let membership = await membershipRepo.get(SEED_TENANT_ID, seedUser.user_id);
      if (!membership) {
        membership = await membershipRepo.create({
          tenant_id: SEED_TENANT_ID,
          user_id: seedUser.user_id,
          roles: seedUser.membership_roles as ('capability_operator' | 'auditor')[],
        }, 'system:seed');
        console.log(`[seed] Created membership: ${seedUser.user_id} -> ${SEED_TENANT_ID} (roles: ${seedUser.membership_roles.length > 0 ? seedUser.membership_roles.join(', ') : '普通成员'})`);
      } else {
        console.log(`[seed] Membership already exists: ${seedUser.user_id} -> ${SEED_TENANT_ID}`);
      }
    }

    console.log('[seed] IAM seed completed successfully.');
    console.log(`[seed] Tenant: ${SEED_TENANT_ID}`);
    console.log('[seed] Users: dev_admin, dev_operator, dev_auditor, dev_member');
    console.log('[seed] dev_admin -> platform_admin (global) + development membership');
    console.log('[seed] dev_operator -> capability_operator');
    console.log('[seed] dev_auditor -> auditor');
    console.log('[seed] dev_member -> (普通成员)');
  } finally {
    await closeDb(db);
  }
}

main().catch((error) => {
  console.error('[seed] Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

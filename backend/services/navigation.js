export const ROLES = Object.freeze(['viewer', 'member', 'admin']);

const ROLE_ALIASES = Object.freeze({ owner: 'admin' });

export const SECTION_ORDER = Object.freeze([
  'workspace',
  'analytics',
  'administration',
]);

export const MODULES = Object.freeze([
  Object.freeze({
    id: 'dashboard',
    label: 'Dashboard',
    path: '/',
    icon: 'LayoutDashboard',
    order: 10,
    section: 'workspace',
    minRole: 'viewer',
  }),
  Object.freeze({
    id: 'contacts',
    label: 'Contacts',
    path: '/contacts',
    icon: 'Users',
    order: 20,
    section: 'workspace',
    minRole: 'viewer',
  }),
  Object.freeze({
    id: 'companies',
    label: 'Companies',
    path: '/companies',
    icon: 'Building2',
    order: 30,
    section: 'workspace',
    minRole: 'viewer',
  }),
  Object.freeze({
    id: 'deals',
    label: 'Deals',
    path: '/deals',
    icon: 'Handshake',
    order: 40,
    section: 'workspace',
    minRole: 'viewer',
  }),
  Object.freeze({
    id: 'leads',
    label: 'Leads',
    path: '/leads',
    icon: 'Target',
    order: 50,
    section: 'workspace',
    minRole: 'member',
  }),
  Object.freeze({
    id: 'inbox',
    label: 'Inbox',
    path: '/inbox',
    icon: 'Inbox',
    order: 52,
    section: 'workspace',
    minRole: 'viewer',
  }),
  Object.freeze({
    id: 'tickets',
    label: 'Tickets',
    path: '/tickets',
    icon: 'Ticket',
    order: 55,
    section: 'workspace',
    minRole: 'viewer',
  }),
  Object.freeze({
    id: 'sequences',
    label: 'Sequences',
    path: '/sequences',
    icon: 'Workflow',
    order: 57,
    section: 'workspace',
    minRole: 'viewer',
  }),
  Object.freeze({
    id: 'reports',
    label: 'Reports',
    path: '/reports',
    icon: 'BarChart3',
    order: 60,
    section: 'analytics',
    minRole: 'viewer',
  }),
  Object.freeze({
    id: 'import_export',
    label: 'Import/Export',
    path: '/import',
    icon: 'ArrowLeftRight',
    order: 70,
    section: 'administration',
    minRole: 'member',
  }),
  Object.freeze({
    id: 'team',
    label: 'Team',
    path: '/team',
    icon: 'ShieldCheck',
    order: 80,
    section: 'administration',
    minRole: 'admin',
  }),
  Object.freeze({
    id: 'integrations',
    label: 'Integrations',
    path: '/integrations',
    icon: 'Webhook',
    order: 85,
    section: 'administration',
    minRole: 'admin',
  }),
  Object.freeze({
    id: 'settings',
    label: 'Settings',
    path: '/settings',
    icon: 'Settings',
    order: 90,
    section: 'administration',
    minRole: 'admin',
  }),
]);

export function normalizeRole(role) {
  if (typeof role !== 'string') return 'viewer';
  const key = role.trim().toLowerCase();
  const alias = ROLE_ALIASES[key];
  if (alias) return alias;
  return ROLES.includes(key) ? key : 'viewer';
}

export function roleRank(role) {
  return ROLES.indexOf(normalizeRole(role));
}

export function canViewModule(role, module) {
  if (!module || typeof module.id !== 'string') return false;
  return roleRank(role) >= ROLES.indexOf(module.minRole);
}

function sectionRank(section) {
  const index = SECTION_ORDER.indexOf(section);
  return index === -1 ? SECTION_ORDER.length : index;
}

export function getNavigationForUser(user) {
  const role = normalizeRole(user && user.role);
  const rank = ROLES.indexOf(role);
  return MODULES.filter((module) => rank >= ROLES.indexOf(module.minRole))
    .slice()
    .sort(
      (a, b) =>
        sectionRank(a.section) - sectionRank(b.section) || a.order - b.order,
    )
    .map((module) => ({
      id: module.id,
      label: module.label,
      path: module.path,
      icon: module.icon,
      order: module.order,
      section: module.section,
      minRole: module.minRole,
    }));
}

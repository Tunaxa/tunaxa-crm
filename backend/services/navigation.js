// Data-driven module navigation (P2-BE1-01).
//
// Pure domain service. It owns exactly two things and nothing else:
//
//   1. The canonical CRM module registry — the single source of truth for what
//      a navigation entry is (`id`, `label`, `path`, `icon`, `order`, `section`,
//      `minRole`).
//   2. The role visibility matrix, expressed as the *lowest* role that may see
//      each module (`minRole`). A caller sees a module when their role ranks at
//      or above that module's `minRole`.
//
// There is no database, request object or framework dependency in this file, so
// the visibility rules are unit-testable in isolation and the HTTP layer
// (`routes/modules.js`) is a thin adapter over `getNavigationForUser()`.
//
// Role vocabulary matches the RBAC middleware (`middleware/rbac.js`):
// `admin` / `member` / `viewer`. `Owner`/`owner` are admin-equivalents there, so
// they resolve to `admin` here rather than silently degrading to `viewer`.
// Anything missing, unrecognized or non-string falls back to `viewer` — the safe
// minimum — so a malformed or forged session can never *widen* navigation.

/**
 * Canonical role ids, lowest privilege first. The array index is the rank used
 * by the visibility comparison, so the order is load-bearing.
 */
export const ROLES = Object.freeze(['viewer', 'member', 'admin']);

/**
 * Roles that are not in `ROLES` but mean "admin" everywhere else in the app
 * (see `ADMIN_ROLES` in `middleware/rbac.js`).
 */
const ROLE_ALIASES = Object.freeze({ owner: 'admin' });

/** Section render order. Sections are the navigation's top level. */
export const SECTION_ORDER = Object.freeze([
  'workspace',
  'analytics',
  'administration',
]);

/**
 * Canonical CRM module registry.
 *
 * `minRole` is the lowest role allowed to see the entry:
 *   - `viewer` — dashboard, core read-only CRM (contacts/companies/deals) and
 *     the standard reports.
 *   - `member` — the viewer set, plus leads and bulk import/export.
 *   - `admin`  — the member set, plus team administration and workspace
 *     settings.
 */
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
    id: 'settings',
    label: 'Settings',
    path: '/settings',
    icon: 'Settings',
    order: 90,
    section: 'administration',
    minRole: 'admin',
  }),
]);

/**
 * Resolve an arbitrary role value to a canonical role id.
 *
 * Never throws and never returns anything outside `ROLES`: a missing,
 * non-string or unrecognized role resolves to `viewer`.
 */
export function normalizeRole(role) {
  if (typeof role !== 'string') return 'viewer';
  const key = role.trim().toLowerCase();
  const alias = ROLE_ALIASES[key];
  if (alias) return alias;
  return ROLES.includes(key) ? key : 'viewer';
}

/** Numeric rank of a role (unknown roles rank as `viewer`). */
export function roleRank(role) {
  return ROLES.indexOf(normalizeRole(role));
}

/** True when `role` is allowed to see `module`. */
export function canViewModule(role, module) {
  if (!module || typeof module.id !== 'string') return false;
  return roleRank(role) >= ROLES.indexOf(module.minRole);
}

function sectionRank(section) {
  const index = SECTION_ORDER.indexOf(section);
  // Unknown sections sort last but never drop out of the list.
  return index === -1 ? SECTION_ORDER.length : index;
}

/**
 * Pure helper: the ordered navigation for a user.
 *
 * Returns a fresh array of plain module objects (a copy, so a caller can never
 * mutate the frozen registry), sorted by section order then module `order`.
 * Accepts anything; an absent/unknown role yields the viewer-level set.
 */
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

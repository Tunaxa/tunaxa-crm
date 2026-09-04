export const ADMIN_ROLES = ['admin', 'Owner', 'owner'];
export const EDIT_ROLES = ['admin', 'member', 'Owner', 'owner'];

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const userRole = req.user.role;
    if (roles.some(r => r === userRole)) return next();
    if (roles.includes('admin') && ADMIN_ROLES.includes(userRole)) return next();
    if (roles.includes('member') && EDIT_ROLES.includes(userRole)) return next();
    return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  };
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!ADMIN_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
  next();
}

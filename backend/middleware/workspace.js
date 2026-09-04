export function withWorkspace(req, res, next) {
  req.workspaceId = req.user?.workspaceId || 'default';
  next();
}

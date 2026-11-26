export function messageScope(req) {
  return req.user?.workspaceId || req.user?.workspace_id || `user:${req.user?.id || "anonymous"}`;
}

export function hasMessageScope(row, req) {
  const scope = messageScope(req);
  const rowScope = row?.workspaceId ?? row?.workspace_id;
  if (rowScope !== undefined && rowScope !== null) return rowScope === scope;
  const owner = row?.userId || row?.ownerId || row?.createdBy;
  if (owner) return `user:${owner}` === scope;
  return !req.user?.workspaceId && !req.user?.workspace_id;
}

// Inbound email sync management endpoints.
//
//   POST /api/email-sync/trigger   run one cycle now (admin/member)
//   GET  /api/email-sync/status    configured/running flags, last cycle counts,
//                                  cumulative processed count, last error
//
// The trigger is deliberately a full cycle rather than a "fetch these uids"
// primitive: callers get the same code path the scheduler runs, including the
// per-mailbox lock, so mashing the button cannot open parallel IMAP sessions.

import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { withWorkspace } from '../middleware/workspace.js';
import {
  runEmailSyncCycle,
  getEmailSyncStatus,
} from '../workers/emailSync.js';

export default function registerEmailSyncRoutes(app) {
  app.post(
    '/api/email-sync/trigger',
    auth,
    requireRole('admin', 'member'),
    withWorkspace,
    async (req, res) => {
      try {
        const result = await runEmailSyncCycle({
          workspaceId: req.workspaceId,
          accountId: req.body?.accountId,
        });
        if (result.error) return res.status(502).json(result);
        return res.json(result);
      } catch (error) {
        console.error('[email-sync] manual trigger failed:', error.message);
        return res.status(500).json({ error: error.message });
      }
    },
  );

  app.get('/api/email-sync/status', auth, withWorkspace, async (req, res) => {
    try {
      const status = await getEmailSyncStatus({
        workspaceId: req.workspaceId,
        accountId: req.query.accountId,
      });
      return res.json(status);
    } catch (error) {
      console.error('[email-sync] status read failed:', error.message);
      return res.status(500).json({ error: error.message });
    }
  });
}

import { readDb, mutateDb } from '../store.js';
import { auth } from '../middleware/auth.js';
import { requireAdmin, requireRole } from '../middleware/rbac.js';
import { id, now } from '../helpers.js';
import { broadcast } from './sse.js';
import { LIFECYCLE_STAGES } from './lifecycle.js';

const DEFAULT_RULES = [
  { id: 'rule_webinar', name: 'Attended webinar', type: 'behavioral', field: 'source', op: 'eq', value: 'Webinar', points: 20, active: true },
  { id: 'rule_web', name: 'Website visit', type: 'behavioral', field: 'source', op: 'eq', value: 'Website', points: 10, active: true },
  { id: 'rule_email', name: 'Opened email', type: 'behavioral', field: 'emailOpened', op: 'eq', value: 'true', points: 5, active: true },
  { id: 'rule_title_dm', name: 'Is a decision maker', type: 'explicit', field: 'role', op: 'in', value: ['CEO', 'CTO', 'VP', 'Director', 'Founder', 'Owner'], points: 25, active: true },
  { id: 'rule_revenue', name: 'Company revenue large', type: 'explicit', field: 'value', op: 'gte', value: '50000', points: 15, active: true },
  { id: 'rule_phone', name: 'Provides phone number', type: 'explicit', field: 'phone', op: 'isSet', value: '', points: 5, active: true },
  { id: 'rule_company', name: 'Has company', type: 'explicit', field: 'company', op: 'isSet', value: '', points: 5, active: true }
];

const DEFAULT_THRESHOLDS = { marketingQualified: 30, salesQualified: 60 };

function applyValue(rules, record) {
  let score = 0;
  for (const rule of rules) {
    if (!rule.active) continue;
    const actual = record[rule.field];
    let matched = false;
    switch (rule.op) {
      case 'eq': matched = String(actual ?? '') === String(rule.value ?? ''); break;
      case 'neq': matched = String(actual ?? '') !== String(rule.value ?? ''); break;
      case 'in': {
        const list = Array.isArray(rule.value) ? rule.value : String(rule.value ?? '').split(',').map(x => x.trim());
        matched = list.includes(String(actual ?? ''));
        break;
      }
      case 'isSet': matched = actual !== undefined && actual !== null && actual !== ''; break;
      case 'isNotSet': matched = actual === undefined || actual === null || actual === ''; break;
      case 'gte': matched = Number(actual) >= Number(rule.value); break;
      case 'lte': matched = Number(actual) <= Number(rule.value); break;
      default: matched = false;
    }
    if (matched) score += Number(rule.points) || 0;
  }
  return score;
}

export function scoreLead(record, rules, thresholds) {
  const score = applyValue(rules, record);
  const tier = score >= (thresholds?.salesQualified || 60) ? 'SQL'
    : score >= (thresholds?.marketingQualified || 30) ? 'MQL'
    : 'Cold';
  return { score, tier };
}

export default function registerLeadScoringRoutes(app) {
  app.get('/api/leadscoring/rules', auth, async (req, res) => {
    const db = await readDb();
    const rules = db.leadScoringRules?.length ? db.leadScoringRules : DEFAULT_RULES;
    const thresholds = db.leadScoringThresholds || DEFAULT_THRESHOLDS;
    res.json({ rules, thresholds });
  });

  app.post('/api/leadscoring/rules', auth, requireAdmin, async (req, res) => {
    const { field, op, value, points, name, type, active } = req.body || {};
    if (!field || !op) return res.status(400).json({ error: 'field and op are required' });
    const saved = await mutateDb(db => {
      if (!db.leadScoringRules) db.leadScoringRules = [...DEFAULT_RULES];
      const rule = { id: id('rule'), name: name || `Score when ${field} ${op} ${Array.isArray(value) ? value.join(',') : value}`, field, op, value: value ?? '', points: Number(points) || 0, type: type === 'explicit' ? 'explicit' : 'behavioral', active: active !== false };
      db.leadScoringRules.push(rule);
      db.audit.unshift({ id: id('audit'), action: `Added lead scoring rule: ${rule.name}`, actor: req.user.name, createdAt: now() });
      return rule;
    });
    broadcast('leadscoring.rules_changed', null, req.user.workspaceId || 'default');
    res.status(201).json(saved);
  });

  app.put('/api/leadscoring/rules/:id', auth, requireAdmin, async (req, res) => {
    const saved = await mutateDb(db => {
      const found = (db.leadScoringRules || []).find(r => r.id === req.params.id);
      if (!found) return null;
      Object.assign(found, req.body, { updatedAt: now() });
      return found;
    });
    if (!saved) return res.status(404).json({ error: 'Rule not found' });
    res.json(saved);
  });

  app.delete('/api/leadscoring/rules/:id', auth, requireAdmin, async (req, res) => {
    const ok = await mutateDb(db => {
      const index = (db.leadScoringRules || []).findIndex(r => r.id === req.params.id);
      if (index < 0) return false;
      db.leadScoringRules.splice(index, 1);
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true });
  });

  app.put('/api/leadscoring/thresholds', auth, requireAdmin, async (req, res) => {
    const { marketingQualified, salesQualified } = req.body || {};
    const saved = await mutateDb(db => {
      db.leadScoringThresholds = {
        marketingQualified: Number(marketingQualified) || 30,
        salesQualified: Number(salesQualified) || 60
      };
      return db.leadScoringThresholds;
    });
    res.json(saved);
  });

  // Compute score for a record
  app.get('/api/leadscoring/score/:recordId', auth, async (req, res) => {
    const db = await readDb();
    const rules = db.leadScoringRules?.length ? db.leadScoringRules : DEFAULT_RULES;
    const thresholds = db.leadScoringThresholds || DEFAULT_THRESHOLDS;
    const record = db.leads.find(x => x.id === req.params.recordId) || db.contacts.find(x => x.id === req.params.recordId);
    if (!record) return res.status(404).json({ error: 'Record not found' });
    const { score, tier } = scoreLead(record, rules, thresholds);
    res.json({ score, tier, recordId: record.id, rules, thresholds });
  });

  // Recompute & persist scores for all leads
  app.post('/api/leadscoring/recalculate', auth, requireRole('admin', 'member'), async (req, res) => {
    const result = await mutateDb(db => {
      const rules = db.leadScoringRules?.length ? db.leadScoringRules : DEFAULT_RULES;
      const thresholds = db.leadScoringThresholds || DEFAULT_THRESHOLDS;
      let updated = 0, sql = 0, mql = 0, cold = 0;
      for (const lead of db.leads) {
        const { score, tier } = scoreLead(lead, rules, thresholds);
        lead.leadScore = score;
        lead.leadScoreTier = tier;
        lead.scoreRecalculatedAt = now();
        updated++;
        if (tier === 'SQL') sql++; else if (tier === 'MQL') mql++; else cold++;
        const currentIdx = LIFECYCLE_STAGES.indexOf(lead.lifecycleStage);
        if (tier === 'SQL' && currentIdx < LIFECYCLE_STAGES.indexOf('SQL')) {
          lead.lifecycleStage = 'SQL';
          db.activities.unshift({ id: id('activity'), title: `Auto SQL by scoring (score ${score})`, type: 'Lead Score', contact: lead.name || lead.email || '', notes: `Score threshold crossed (≥ ${thresholds.salesQualified})`, date: now().slice(0, 10), recordId: lead.id, createdAt: now(), updatedAt: now() });
        } else if (tier === 'MQL' && currentIdx < LIFECYCLE_STAGES.indexOf('MQL')) {
          lead.lifecycleStage = 'MQL';
        }
      }
      db.audit.unshift({ id: id('audit'), action: `Recalculated lead scores for ${updated} leads`, actor: req.user.name, createdAt: now() });
      return { updated, breakdown: { sql, mql, cold } };
    });
    broadcast('leadscoring.recalculated', result, req.user.workspaceId || 'default');
    res.json(result);
  });
}
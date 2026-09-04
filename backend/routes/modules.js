import { readDb } from '../store.js';
import { auth } from '../middleware/auth.js';

const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const monthKeyOf = iso => String(iso || '').slice(0, 7);

export default function registerModuleRoutes(app) {
  // --- Marketing ---
  app.get('/api/marketing/summary', auth, async (req, res) => {
    const db = await readDb();
    const campaigns = db.campaigns || [];
    const active = campaigns.filter(c => c.status === 'Active');
    const totalTarget = campaigns.reduce((sum, c) => sum + num(c.target), 0);
    const totalReached = campaigns.reduce((sum, c) => sum + num(c.reached), 0);
    const totalLeads = campaigns.reduce((sum, c) => sum + num(c.leads), 0);
    const byStatus = {};
    for (const c of campaigns) byStatus[c.status || 'Draft'] = (byStatus[c.status || 'Draft'] || 0) + 1;
    res.json({
      campaigns: campaigns.length,
      active,
      lists: (db.emailLists || []).length,
      pages: (db.landingPages || []).length,
      totalTarget,
      totalReached,
      totalLeads,
      conversionRate: totalReached > 0 ? Number(((totalLeads / totalReached) * 100).toFixed(1)) : 0,
      byStatus
    });
  });

  // --- Commerce ---
  app.get('/api/commerce/summary', auth, async (req, res) => {
    const db = await readDb();
    const products = db.products || [];
    const orders = db.orders || [];
    const revenue = orders.reduce((sum, o) => sum + num(o.total), 0);
    const paid = orders.filter(o => o.status === 'Paid');
    const outstanding = orders.filter(o => o.status === 'Pending' || o.status === 'Awaiting payment');
    const lowStock = products.filter(p => {
      const min = num(p.minStock);
      const stock = num(p.stock);
      return min > 0 && stock <= min;
    });
    const byStatus = {};
    for (const o of orders) byStatus[o.status || 'Draft'] = (byStatus[o.status || 'Draft'] || 0) + 1;
    res.json({
      products: products.length,
      orders: orders.length,
      revenue,
      paidCount: paid.length,
      outstandingCount: outstanding.length,
      outstandingValue: outstanding.reduce((sum, o) => sum + num(o.total), 0),
      lowStock: lowStock.length,
      avgOrderValue: orders.length ? Number((revenue / orders.length).toFixed(2)) : 0,
      byStatus
    });
  });

  // --- Finance (invoices, expenses, revenue forecast) ---
  app.get('/api/finance/summary', auth, async (req, res) => {
    const db = await readDb();
    const invoices = db.invoices || [];
    const expenses = db.expenses || [];
    const months = Math.min(12, parseInt(req.query.months) || 6);

    const issued = invoices.reduce((sum, i) => sum + num(i.amount), 0);
    const paid = invoices.filter(i => i.status === 'Paid');
    const unpaid = invoices.filter(i => i.status === 'Pending' || i.status === 'Overdue');
    const paidValue = paid.reduce((sum, i) => sum + num(i.amount), 0);
    const dueValue = unpaid.reduce((sum, i) => sum + num(i.amount), 0);
    const totalExpenses = expenses.reduce((sum, e) => sum + num(e.amount), 0);

    const monthly = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const key = monthKeyOf(d.toISOString());
      const label = d.toLocaleString('en', { month: 'short', year: '2-digit' });
      const rev = invoices.filter(x => x.status === 'Paid' && monthKeyOf(x.paidAt || x.createdAt) === key);
      const exp = expenses.filter(x => monthKeyOf(x.date || x.createdAt) === key);
      const revenue = rev.reduce((sum, x) => sum + num(x.amount), 0);
      const cost = exp.reduce((sum, x) => sum + num(x.amount), 0);
      monthly.push({ month: key, label, revenue: Number(revenue.toFixed(2)), expenses: Number(cost.toFixed(2)), profit: Number((revenue - cost).toFixed(2)) });
    }

    const last3 = monthly.slice(-3);
    const avg = last3.length ? last3.reduce((s, m) => s + m.revenue, 0) / last3.length : 0;
    const currentRevenue = monthly.length ? monthly[monthly.length - 1].revenue : 0;
    const forecast = new Array(3).fill(0).map((_, i) => {
      const d = new Date();
      d.setMonth(d.getMonth() + (i + 1));
      const monthLabel = d.toLocaleString('en', { month: 'short', year: '2-digit' });
      return { month: monthKeyOf(d.toISOString()), label: monthLabel, projected: Number((avg * 0.9 * (i + 1) + currentRevenue).toFixed(2)) };
    });

    res.json({
      issued,
      paidCount: paid.length,
      unpaidCount: unpaid.length,
      paidValue,
      dueValue,
      totalExpenses,
      net: Number((paidValue - totalExpenses).toFixed(2)),
      monthly,
      avgMonthlyRevenue: Number(avg.toFixed(2)),
      forecast
    });
  });

  // --- HR ---
  app.get('/api/hr/summary', auth, async (req, res) => {
    const db = await readDb();
    const employees = db.employees || [];
    const leave = db.leaveRequests || [];
    const attendance = db.attendance || [];
    const active = employees.filter(e => e.status === 'Active');
    const pending = leave.filter(l => l.status === 'Pending');
    const approved = leave.filter(l => l.status === 'Approved');
    const presentToday = attendance.filter(a => {
      const today = new Date().toISOString().slice(0, 10);
      return a.date === today && a.status !== 'Absent' && a.status !== 'On leave';
    });
    const byDepartment = {};
    for (const e of active) byDepartment[e.department || 'General'] = (byDepartment[e.department || 'General'] || 0) + 1;
    res.json({
      employees: employees.length,
      active,
      leave: leave.length,
      pendingLeave: pending.length,
      approvedLeave: approved.length,
      attendance: attendance.length,
      presentToday: presentToday.length,
      onLeaveToday: attendance.filter(a => a.date === new Date().toISOString().slice(0, 10) && a.status === 'On leave').length,
      byDepartment
    });
  });
}

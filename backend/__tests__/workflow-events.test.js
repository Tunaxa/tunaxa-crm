import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import { createdEvent, updatedEvent } from '../services/workflows.js';
import { AUTOMATION_PLAYBOOKS, seedPlaybooks } from '../services/seedPlaybooks.js';
import { readDb, mutateDb } from '../store.js';

let app;
let token;

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
});

afterAll(() => cleanupTestDb());

describe('Workflow engine events for module resources', () => {
  it('emits createdEvent for every module resource', () => {
    expect(createdEvent('products')).toBe('product.created');
    expect(createdEvent('invoices')).toBe('invoice.created');
    expect(createdEvent('orders')).toBe('order.created');
    expect(createdEvent('expenses')).toBe('expense.created');
    expect(createdEvent('employees')).toBe('employee.created');
    expect(createdEvent('campaigns')).toBe('campaign.created');
    expect(createdEvent('emailLists')).toBe('emailList.created');
    expect(createdEvent('landingPages')).toBe('landingPage.created');
    expect(createdEvent('leaveRequests')).toBe('leaveRequest.created');
    expect(createdEvent('attendance')).toBe('attendance.created');
  });

  it('emits updatedEvent for every module resource', () => {
    expect(updatedEvent('products')).toBe('product.updated');
    expect(updatedEvent('invoices')).toBe('invoice.updated');
    expect(updatedEvent('orders')).toBe('order.updated');
    expect(updatedEvent('expenses')).toBe('expense.updated');
    expect(updatedEvent('employees')).toBe('employee.updated');
  });

  it('seeds exactly the 8 automation playbooks idempotently', async () => {
    await seedPlaybooks();
    const db = await readDb();
    expect(db.workflows.filter(w => AUTOMATION_PLAYBOOKS.some(p => p.name === w.name)).length).toBe(8);
    await seedPlaybooks();
    const db2 = await readDb();
    expect(db2.workflows.filter(w => AUTOMATION_PLAYBOOKS.some(p => p.name === w.name)).length).toBe(8);
  });

  it('scaffolds fireable events for the low-stock and invoice playbooks', async () => {
    for (const playbook of AUTOMATION_PLAYBOOKS) {
      expect(playbook.event.split('.')[0]).toContain(
        ['lead', 'contact', 'deal', 'form', 'product', 'invoice', 'task', 'webhook'].find(p => playbook.event.startsWith(p))
      );
    }
    expect(AUTOMATION_PLAYBOOKS.find(p => p.name === 'Low-stock reorder reminder').event).toBe('product.updated');
    expect(AUTOMATION_PLAYBOOKS.find(p => p.name === 'Invoice overdue reminder').event).toBe('invoice.created');
  });
});

describe('Workflows actually fire on module events', () => {
  it('product update triggers the low-stock reorder task', async () => {
    await mutateDb(db => {
      db.workflows.push({
        id: 'workflow_lowstock_test', name: 'Low-stock test', event: 'product.updated', enabled: true,
        filter: { field: 'stock', op: 'isSet' },
        actions: [{ type: 'task', title: 'Reorder low-stock product {{name}}', owner: '', priority: 'High', dueDate: '' }],
        createdAt: new Date().toISOString(), createdBy: 'System', updatedAt: new Date().toISOString()
      });
    });

    const product = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Widget', price: 9.99, stock: 5, minStock: 10 });
    expect(product.status).toBe(201);

    await request(app)
      .put(`/api/products/${product.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stock: 4 });

    const tasks = await request(app).get('/api/tasks').set('Authorization', `Bearer ${token}`);
    const created = tasks.body.find(t => t.title === 'Reorder low-stock product Widget');
    expect(created).toBeTruthy();
  });

  it('invoice creation triggers the unpaid-reminder email', async () => {
    await mutateDb(db => {
      db.workflows.push({
        id: 'workflow_invoice_test', name: 'Invoice overdue test', event: 'invoice.created', enabled: true,
        filter: { field: 'status', op: 'neq', value: 'paid' },
        actions: [{ type: 'email', to: '{{customerEmail}}', subject: 'Invoice reminder', body: 'Hi {{customerName}}, reminder about {{number}}.' }],
        createdAt: new Date().toISOString(), createdBy: 'System', updatedAt: new Date().toISOString()
      });
    });

    const invoice = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${token}`)
      .send({ number: 'INV-5002', amount: 250, status: 'unpaid', customerName: 'Acme', customerEmail: 'acme@test.com' });
    expect(invoice.status).toBe(201);

    const messages = await request(app).get('/api/messages').set('Authorization', `Bearer ${token}`);
    const created = messages.body.find(m => m.subject === 'Invoice reminder');
    expect(created).toBeTruthy();
    expect(created.to).toBe('acme@test.com');
  });
});

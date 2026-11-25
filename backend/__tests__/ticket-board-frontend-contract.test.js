import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { cleanupTestDb, loginAs, resetTestDb, seedTestUser } from './setup.js';
import { parseTicketBoard, saveTicketMove, ticketCreatePayload, ticketSla } from '../../web/src/modules/service/ticketBoard.ts';

let app, token;
const auth = req => req.set('Authorization', `Bearer ${token}`);
beforeAll(async () => {
  await resetTestDb();
  app = (await import('../server.js')).app;
  await seedTestUser();
  token = await loginAs(app);
});
afterAll(() => cleanupTestDb());

describe('Ticket board frontend through the existing API', () => {
  it('creates a ticket, loads the full board and preserves a first response through consecutive moves', async () => {
    const created = await auth(request(app).post('/api/tickets')).send(ticketCreatePayload({ subject: 'Frontend board request', contact: 'Alex', priority: 'Normal', source: 'Email' }));
    expect(created.status).toBe(201);
    const list = await auth(request(app).get('/api/tickets'));
    expect(list.status).toBe(200);
    const board = parseTicketBoard(list.body);
    const ticket = board.data.find(row => row.id === created.body.id);
    expect(ticket).toBeDefined();
    expect(ticketSla(ticket, board.sla, Date.now()).first.state).toBe('remaining');
    const send = async payload => {
      const response = await auth(request(app).put(`/api/tickets/${ticket.id}`)).send(payload);
      if (response.status !== 200) throw Object.assign(new Error(response.body.error), { status: response.status });
      return response.body;
    };
    const progressing = await saveTicketMove(ticket, 'In Progress', board.stages, send);
    expect(progressing.firstResponseAt).toBeTruthy();
    const waiting = await saveTicketMove(progressing, 'Awaiting Client', board.stages, send);
    expect(waiting.firstResponseAt).toBe(progressing.firstResponseAt);
    const resolved = await saveTicketMove(waiting, 'Resolved', board.stages, send);
    expect(resolved.resolvedAt).toBeTruthy();
    const reload = parseTicketBoard((await auth(request(app).get('/api/tickets'))).body);
    expect(reload.data.find(row => row.id === ticket.id).stage).toBe('Resolved');
    expect(ticketSla(resolved, reload.sla, Date.now() + 100 * 3600000).overdue).toBe(false);
  });
  it('rejects an invalid destination before writing to the API', async () => {
    const board = parseTicketBoard((await auth(request(app).get('/api/tickets'))).body);
    let sent = false;
    await expect(saveTicketMove(board.data[0], 'Unknown stage', board.stages, async () => { sent = true; })).rejects.toThrow('Cannot move');
    expect(sent).toBe(false);
  });
});

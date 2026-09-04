import { auth } from '../middleware/auth.js';

const clients = new Map();

export function broadcast(event, data, userId) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, client] of clients) {
    if (userId && client.userId !== userId) continue;
    client.res.write(payload);
  }
}

export default function registerSseRoutes(app) {
  app.get('/api/events', auth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write(`event: connected\ndata: ${JSON.stringify({ userId: req.user.id })}\n\n`);

    const clientId = `${req.user.id}-${Date.now()}`;
    clients.set(clientId, { res, userId: req.user.id });

    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 30_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(clientId);
    });
  });

  app.get('/api/events/clients', auth, (req, res) => {
    res.json({ count: clients.size });
  });
}

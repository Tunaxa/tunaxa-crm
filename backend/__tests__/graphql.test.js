import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { closePool } from '../db/pg.js';
import { resetTestDb, cleanupTestDb } from './setup.js';
import { mutateDb } from '../store.js';

let app, ownerToken, viewerToken;
let createdId = null;
const uniq = Date.now();

function password() {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('test123', salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

async function login(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'test123' });
  return res.body.token;
}

const gql = (token, query, variables) =>
  request(app)
    .post('/api/graphql')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .send({ query, variables });

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await mutateDb(db => {
    db.users.unshift({ id: 'usr_gql_owner', name: 'GQ Owner', email: `gql-owner-${uniq}@test.com`, password: password(), role: 'Owner', createdAt: new Date().toISOString() });
    db.users.unshift({ id: 'usr_gql_viewer', name: 'GQ Viewer', email: `gql-viewer-${uniq}@test.com`, password: password(), role: 'viewer', createdAt: new Date().toISOString() });
  });
  ownerToken = await login(`gql-owner-${uniq}@test.com`);
  viewerToken = await login(`gql-viewer-${uniq}@test.com`);
});

afterAll(async () => {
  await closePool();
  await cleanupTestDb();
});

describe('GraphQL layer (/api/graphql)', () => {
  it('query objects (list) returns data for owner', async () => {
    const query = `{ objects(type: "company", limit: 20) { data { id object_type } total } }`;
    const res = await gql(ownerToken, query);
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(typeof res.body.data.objects.total).toBe('number');
  });

  it('createObject mutation succeeds for owner', async () => {
    const query = `
      mutation ($props: JSON!) {
        createObject(type: "company", properties: $props) { id object_type properties }
      }`;
    const res = await gql(ownerToken, query, { props: { name: `GraphQL Corp ${uniq}`, industry: 'SaaS' } });
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.createObject.object_type).toBe('company');
    expect(res.body.data.createObject.properties.name).toBe(`GraphQL Corp ${uniq}`);
    createdId = res.body.data.createObject.id;
  });

  it('query object by id returns the created object', async () => {
    const query = `{ object(type: "company", id: "${createdId}") { id object_type properties } }`;
    const res = await gql(ownerToken, query);
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.object.id).toBe(createdId);
  });

  it('updateObject mutation succeeds for owner', async () => {
    const query = `
      mutation ($props: JSON!) {
        updateObject(type: "company", id: "${createdId}", properties: $props) { id properties }
      }`;
    const res = await gql(ownerToken, query, { props: { industry: 'Fintech' } });
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.updateObject.properties.industry).toBe('Fintech');
  });

  it('deleteObject mutation succeeds for owner', async () => {
    const query = `
      mutation { deleteObject(type: "company", id: "${createdId}") { ok id } }`;
    const res = await gql(ownerToken, query);
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.deleteObject.ok).toBe(true);
  });

  it('viewer can query (read) but NOT mutate', async () => {
    const readQuery = `{ objects(type: "company", limit: 5) { total } }`;
    const readRes = await gql(viewerToken, readQuery);
    expect(readRes.status).toBe(200);
    expect(readRes.body.errors).toBeUndefined();

    const mutQuery = `
      mutation ($props: JSON!) {
        createObject(type: "company", properties: $props) { id }
      }`;
    const mutRes = await gql(viewerToken, mutQuery, { props: { name: 'Nope' } });
    // mutation is blocked: either 403 via FORBIDDEN extension, or 200 with errors in body
    expect([200, 403]).toContain(mutRes.status);
    if (mutRes.status === 200) {
      expect(mutRes.body.errors).toBeDefined();
    } else {
      expect(mutRes.body).toMatchObject({});
    }
  });

  it('schema query returns definitions', async () => {
    const query = `{ schema(type: "company") { name } }`;
    const res = await gql(ownerToken, query);
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(Array.isArray(res.body.data.schema)).toBe(true);
  });

  it('no auth -> 401 on GraphQL endpoint', async () => {
    const res = await request(app)
      .post('/api/graphql')
      .set('Content-Type', 'application/json')
      .send({ query: '{ objects(type: "company") { total } }' });
    expect(res.status).toBe(401);
  });
});

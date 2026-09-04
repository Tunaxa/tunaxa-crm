import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';
import { createSchema, createYoga } from 'graphql-yoga';
import { auth } from '../middleware/auth.js';
import { ADMIN_ROLES, EDIT_ROLES } from '../middleware/rbac.js';
import {
  createObject, getObject, updateObject, deleteObject,
  listObjects, searchObjects, getPropertyDefinitions
} from '../db/store.js';
import { broadcast } from './sse.js';

function canWrite(user) {
  return !!user && EDIT_ROLES.includes(user.role);
}

function requireWrite(user) {
  if (!user) throw new GraphQLError('Unauthorized: authentication required', { extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } } });
  if (!canWrite(user)) throw new GraphQLError('Forbidden: read-only role', { extensions: { code: 'FORBIDDEN', http: { status: 403 } } });
}

const typeDefs = /* GraphQL */ `
  type ObjectRecord {
    id: ID!
    object_type: String!
    properties: JSON
    created_at: String
    updated_at: String
    workspace_id: String
  }

  type ListResult {
    data: [ObjectRecord!]!
    total: Int!
  }

  scalar JSON

  type Query {
    object(type: String!, id: ID!): ObjectRecord
    objects(type: String!, limit: Int, offset: Int, search: String, filters: JSON): ListResult!
    schema(type: String!): [PropertyDefinition!]!
  }

  type PropertyDefinition {
    name: String!
    type: String
    required: Boolean
    label: String
  }

  type Mutation {
    createObject(type: String!, properties: JSON!): ObjectRecord!
    updateObject(type: String!, id: ID!, properties: JSON!): ObjectRecord!
    deleteObject(type: String!, id: ID!): DeleteResult!
  }

  type DeleteResult {
    ok: Boolean!
    id: ID!
  }
`;

const jsonScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value',
  serialize: value => value,
  parseValue: value => value,
  parseLiteral: ast => {
    switch (ast.kind) {
      case Kind.STRING: return ast.value;
      case Kind.BOOLEAN: return ast.value;
      case Kind.INT: return parseInt(ast.value, 10);
      case Kind.FLOAT: return parseFloat(ast.value);
      case Kind.OBJECT: {
        const obj = {};
        for (const field of ast.fields) obj[field.name.value] = jsonScalar.parseLiteral(field.value);
        return obj;
      }
      case Kind.LIST: return ast.values.map(v => jsonScalar.parseLiteral(v));
      case Kind.NULL: return null;
      default: return null;
    }
  },
});

const resolvers = {
  JSON: jsonScalar,
  Query: {
    object: async (_parent, { type, id }, ctx) => {
      const obj = await getObject(id);
      if (!obj || obj.object_type !== type) return null;
      return obj;
    },
    objects: async (_parent, { type, limit = 100, offset = 0, search, filters }, ctx) => {
      const workspaceId = ctx.user?.workspaceId || 'default';
      if (search) {
        const results = await searchObjects(type, search, { limit: Math.min(limit, 100), workspaceId });
        return { data: results, total: results.length };
      }
      const result = await listObjects(type, {
        limit: Math.min(limit, 100),
        offset,
        filters: filters || {},
        workspaceId,
      });
      return { data: result.data || result, total: result.total ?? (result.data || []).length };
    },
    schema: async (_parent, { type }) => {
      const rows = await getPropertyDefinitions(type);
      return rows.map(r => ({ name: r.field_name, type: r.field_type, required: r.required, label: r.label }));
    },
  },
  Mutation: {
    createObject: async (_parent, { type, properties }, ctx) => {
      requireWrite(ctx.user);
      const obj = await createObject(type, properties, ctx.user?.workspaceId || 'default');
      broadcast('v1object.created', { type, item: obj });
      return obj;
    },
    updateObject: async (_parent, { type, id, properties }, ctx) => {
      requireWrite(ctx.user);
      const existing = await getObject(id);
      if (!existing || existing.object_type !== type) {
        throw new Error(`Object ${id} not found in type ${type}`);
      }
      const updated = await updateObject(id, properties);
      broadcast('v1object.updated', { type, item: updated });
      return updated;
    },
    deleteObject: async (_parent, { type, id }, ctx) => {
      requireWrite(ctx.user);
      const existing = await getObject(id);
      if (!existing || existing.object_type !== type) {
        throw new Error(`Object ${id} not found in type ${type}`);
      }
      await deleteObject(id);
      broadcast('v1object.deleted', { type, id });
      return { ok: true, id };
    },
  },
};

export default function registerGraphQLRoutes(app) {
  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    context: (ctx) => ({ user: ctx?.user || null }),
    graphiql: true,
    graphqlEndpoint: '/api/graphql',
  });

  // Auth only — both read and write operations enforce role checks on mutations.
  app.use('/api/graphql', auth, YogaToExpress(yoga));
}

// Adapt graphql-yoga's fetch-style handler to an Express middleware by
// converting the Node IncomingMessage into a WHATWG Request, then forwarding
// the authenticated user into Yoga's context via the params argument.
function YogaToExpress(yoga) {
  return async (req, res) => {
    const url = new URL(req.originalUrl || req.url, `http://${req.headers.host || 'localhost'}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) value.forEach(v => headers.append(key, v));
      else headers.set(key, String(value));
    }
    const isBodyMethod = req.method !== 'GET' && req.method !== 'HEAD';
    const body = isBodyMethod ? JSON.stringify(req.body ?? {}) : undefined;
    const fwd = new Request(url, {
      method: req.method,
      headers,
      body,
      duplex: 'half',
    });
    const response = await yoga.fetch(fwd, { user: req.user });
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const text = await response.text();
    res.send(text);
  };
}

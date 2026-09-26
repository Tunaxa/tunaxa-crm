import { query, transaction } from "./pg.js";
import crypto from "node:crypto";

let _dispatchWebhook = null;
async function dispatch(eventType, objectType, objectId, changed = {}) {
  if (!_dispatchWebhook) {
    try {
      const m = await import("../routes/webhooks.js");
      _dispatchWebhook = m.dispatchWebhook;
    } catch {
      _dispatchWebhook = () => {};
    }
  }
  _dispatchWebhook(eventType, objectType, objectId, changed);
}

// ============================================
// Dynamic CRM Object Store (PostgreSQL + JSONB)
// ============================================

/**
 * Create a new CRM object with dynamic properties
 */
export async function createObject(
  objectType,
  properties = {},
  workspaceId = "default",
) {
  const id = crypto.randomUUID();
  const result = await query(
    `INSERT INTO crm_objects (id, object_type, properties, workspace_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, object_type, properties, created_at, updated_at`,
    [id, objectType, JSON.stringify(properties), workspaceId],
  );
  const obj = result.rows[0];
  dispatch(`${objectType}.created`, objectType, obj.id, properties);
  return obj;
}

/**
 * Get a single CRM object by ID
 */
export async function getObject(id) {
  const result = await query(
    `SELECT id, object_type, properties, created_at, updated_at
     FROM crm_objects WHERE id = $1`,
    [id],
  );
  return result.rows[0] || null;
}

/**
 * Update a CRM object's properties (partial merge)
 */
export async function updateObject(id, properties) {
  const result = await query(
    `UPDATE crm_objects
     SET properties = properties || $2::jsonb
     WHERE id = $1
     RETURNING id, object_type, properties, created_at, updated_at`,
    [id, JSON.stringify(properties)],
  );
  const obj = result.rows[0];
  if (obj)
    dispatch(`${obj.object_type}.updated`, obj.object_type, obj.id, properties);
  return obj || null;
}

/**
 * Delete a CRM object by ID
 */
export async function deleteObject(id) {
  const result = await query(
    `DELETE FROM crm_objects WHERE id = $1 RETURNING id, object_type`,
    [id],
  );
  const row = result.rows[0];
  if (row) dispatch(`${row.object_type}.deleted`, row.object_type, row.id);
  return row || null;
}

/**
 * List CRM objects by type with optional filtering, pagination
 */
export async function listObjects(
  objectType,
  {
    limit = 100,
    offset = 0,
    orderBy = "created_at",
    orderDir = "DESC",
    filters = {},
    workspaceId = "default",
  } = {},
) {
  const conditions = ["object_type = $1", "workspace_id = $2"];
  const params = [objectType, workspaceId];
  let paramIndex = 3;

  // Apply JSONB property filters
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    conditions.push(`properties->>$${paramIndex} = $${paramIndex + 1}`);
    params.push(key, String(value));
    paramIndex += 2;
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";
  const validOrders = ["created_at", "updated_at"];
  const orderCol = validOrders.includes(orderBy) ? orderBy : "created_at";
  const orderDirection = orderDir.toUpperCase() === "ASC" ? "ASC" : "DESC";

  params.push(limit, offset);
  const result = await query(
    `SELECT id, object_type, properties, created_at, updated_at
     FROM crm_objects
     ${whereClause}
     ORDER BY ${orderCol} ${orderDirection}
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    params,
  );

  // Get total count for pagination
  const countParams = params.slice(0, -2);
  const countResult = await query(
    `SELECT COUNT(*)::int as total FROM crm_objects ${whereClause}`,
    countParams,
  );

  return {
    data: result.rows,
    total: countResult.rows[0].total,
    limit,
    offset,
  };
}

/**
 * Search CRM objects by JSONB property values (full-text across all properties)
 */
export async function searchObjects(
  objectType,
  searchTerm,
  { limit = 20, workspaceId = "default" } = {},
) {
  const result = await query(
    `SELECT id, object_type, properties, created_at, updated_at
     FROM crm_objects
     WHERE object_type = $1
       AND workspace_id = $2
       AND properties::text ILIKE $3
     ORDER BY updated_at DESC
     LIMIT $4`,
    [objectType, workspaceId, `%${searchTerm}%`, limit],
  );
  return result.rows;
}

/**
 * Get CRM objects updated after a cursor (for incremental sync)
 */
export async function getObjectsSince(
  objectType,
  cursor,
  { limit = 100, workspaceId = "default" } = {},
) {
  const result = await query(
    `SELECT id, object_type, properties, created_at, updated_at
     FROM crm_objects
     WHERE object_type = $1
       AND workspace_id = $2
       AND updated_at > $3
     ORDER BY updated_at ASC
     LIMIT $4`,
    [objectType, workspaceId, cursor, limit],
  );
  return result.rows;
}

/**
 * Batch create objects in a single transaction
 */
export async function batchCreate(objectType, items, workspaceId = "default") {
  return transaction(async (client) => {
    const results = [];
    for (const properties of items) {
      const id = crypto.randomUUID();
      const result = await client.query(
        `INSERT INTO crm_objects (id, object_type, properties, workspace_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, object_type, properties, created_at, updated_at`,
        [id, objectType, JSON.stringify(properties), workspaceId],
      );
      results.push(result.rows[0]);
    }
    return results;
  });
}

/**
 * Batch upsert objects (INSERT ... ON CONFLICT DO UPDATE)
 */
export async function batchUpsert(
  objectType,
  items,
  { workspaceId = "default" } = {},
) {
  return transaction(async (client) => {
    const results = [];
    for (const item of items) {
      const id = item.id || crypto.randomUUID();
      const properties = { ...item };
      delete properties.id;
      const result = await client.query(
        `INSERT INTO crm_objects (id, object_type, properties, workspace_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
         SET properties = crm_objects.properties || EXCLUDED.properties,
             updated_at = NOW()
         RETURNING id, object_type, properties, created_at, updated_at`,
        [id, objectType, JSON.stringify(properties), workspaceId],
      );
      results.push(result.rows[0]);
    }
    return results;
  });
}

// ============================================
// Property Definitions (Metadata)
// ============================================

/**
 * Get all property definitions for an object type
 */
export async function getPropertyDefinitions(objectType) {
  const result = await query(
    `SELECT id, object_type, field_name, field_type, label, required, options, created_at, updated_at
     FROM property_definitions
     WHERE object_type = $1
     ORDER BY field_name`,
    [objectType],
  );
  return result.rows;
}

/**
 * Create a new property definition
 */
export async function createPropertyDefinition(
  objectType,
  { fieldName, fieldType, label, required = false, options = [] },
) {
  const result = await query(
    `INSERT INTO property_definitions (object_type, field_name, field_type, label, required, options)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (object_type, field_name) DO UPDATE
     SET field_type = EXCLUDED.field_type, label = EXCLUDED.label,
         required = EXCLUDED.required, options = EXCLUDED.options, updated_at = NOW()
     RETURNING id, object_type, field_name, field_type, label, required, options, created_at, updated_at`,
    [
      objectType,
      fieldName,
      fieldType,
      label,
      required,
      JSON.stringify(options),
    ],
  );
  return result.rows[0];
}

/**
 * Validate properties against property definitions
 * @param {boolean} partial - If true, only validate provided fields (for PATCH)
 */
export async function validateProperties(
  objectType,
  properties,
  { partial = false } = {},
) {
  const defs = await getPropertyDefinitions(objectType);
  const errors = [];

  for (const def of defs) {
    const value = properties[def.field_name];

    // Skip fields not in the payload for partial updates
    if (partial && !(def.field_name in properties)) continue;

    // Required check
    if (
      def.required &&
      (value === undefined || value === null || value === "")
    ) {
      errors.push({
        field: def.field_name,
        message: `${def.label} is required`,
      });
      continue;
    }

    if (value === undefined || value === null || value === "") continue;

    // Type validation
    switch (def.field_type) {
      case "number":
        if (typeof value !== "number" && isNaN(Number(value))) {
          errors.push({
            field: def.field_name,
            message: `${def.label} must be a number`,
          });
        }
        break;
      case "boolean":
        if (
          typeof value !== "boolean" &&
          !["true", "false", "1", "0"].includes(String(value))
        ) {
          errors.push({
            field: def.field_name,
            message: `${def.label} must be a boolean`,
          });
        }
        break;
      case "date":
        if (isNaN(Date.parse(String(value)))) {
          errors.push({
            field: def.field_name,
            message: `${def.label} must be a valid date`,
          });
        }
        break;
      case "enum": {
        let options = def.options;
        if (typeof options === "string") {
          try {
            options = JSON.parse(options);
          } catch {
            options = [];
          }
        }
        if (!Array.isArray(options)) options = [];
        if (options.length && !options.includes(String(value))) {
          errors.push({
            field: def.field_name,
            message: `${def.label} must be one of: ${options.join(", ")}`,
          });
        }
        break;
      }
    }
  }

  return errors;
}

// ============================================
// Graph Associations
// ============================================

/**
 * Create an association between two objects
 */
export async function createAssociation(
  fromObjectId,
  toObjectId,
  associationType,
  label = "primary",
) {
  const result = await query(
    `INSERT INTO object_associations (from_object_id, to_object_id, association_type, label)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (from_object_id, to_object_id, association_type) DO UPDATE
     SET label = EXCLUDED.label
     RETURNING id, from_object_id, to_object_id, association_type, label, created_at`,
    [fromObjectId, toObjectId, associationType, label],
  );
  return result.rows[0];
}

/**
 * Delete an association
 */
export async function deleteAssociation(
  fromObjectId,
  toObjectId,
  associationType,
) {
  const result = await query(
    `DELETE FROM object_associations
     WHERE from_object_id = $1 AND to_object_id = $2 AND association_type = $3
     RETURNING id`,
    [fromObjectId, toObjectId, associationType],
  );
  return result.rows[0] || null;
}

/**
 * Get all associations for an object (both directions)
 */
export async function getAssociations(
  objectId,
  { associationType, direction = "both" } = {},
) {
  let sql = "";
  const params = [];

  if (direction === "outgoing" || direction === "both") {
    sql += `
      SELECT a.id, a.from_object_id, a.to_object_id, a.association_type, a.label, a.created_at,
             o.object_type AS to_object_type, o.properties AS to_object_properties
      FROM object_associations a
      JOIN crm_objects o ON o.id = a.to_object_id
      WHERE a.from_object_id = $1`;
    params.push(objectId);
    if (associationType) {
      sql += ` AND a.association_type = $2`;
      params.push(associationType);
    }
  }

  if (direction === "both") {
    sql += ` UNION `;
  }

  if (direction === "incoming" || direction === "both") {
    const offset = params.length;
    sql += `
      SELECT a.id, a.from_object_id, a.to_object_id, a.association_type, a.label, a.created_at,
             o.object_type AS from_object_type, o.properties AS from_object_properties
      FROM object_associations a
      JOIN crm_objects o ON o.id = a.from_object_id
      WHERE a.to_object_id = $${offset + 1}`;
    params.push(objectId);
    if (associationType) {
      sql += ` AND a.association_type = $${offset + 2}`;
      params.push(associationType);
    }
  }

  sql += ` ORDER BY created_at DESC`;

  const result = await query(sql, params);
  return result.rows;
}

/**
 * Get all associations between two specific objects
 */
export async function getAssociationsBetween(fromObjectId, toObjectId) {
  const result = await query(
    `SELECT id, from_object_id, to_object_id, association_type, label, created_at
     FROM object_associations
     WHERE (from_object_id = $1 AND to_object_id = $2)
        OR (from_object_id = $2 AND to_object_id = $1)
     ORDER BY created_at DESC`,
    [fromObjectId, toObjectId],
  );
  return result.rows;
}

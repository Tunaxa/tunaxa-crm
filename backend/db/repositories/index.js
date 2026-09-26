// Single lookup table mapping a resource name to its Postgres repository.
//
// Both the write path (routes/resources.js) and the read paths that must agree
// with it (routes/dataops.js duplicate detection) need the same mapping. The
// ternaries they used to carry only handled two resources and silently fell
// through to the wrong repository for anything else, so the mapping lives here
// instead and every caller derives it from one place.

import * as contacts from "./contacts.js";
import * as leads from "./leads.js";
import * as companies from "./companies.js";
import * as deals from "./deals.js";
import * as tasks from "./tasks.js";
import * as activities from "./activities.js";

export const repositories = {
  contacts,
  leads,
  companies,
  deals,
  tasks,
  activities,
};

/** Repository module for `resource`, or null when it is not stored in PG. */
export function repoFor(resource) {
  return repositories[resource] || null;
}

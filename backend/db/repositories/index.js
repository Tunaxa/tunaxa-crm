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
import * as products from "./products.js";
import * as quotes from "./quotes.js";
import * as contracts from "./contracts.js";
import * as orders from "./orders.js";
import * as invoices from "./invoices.js";
import * as expenses from "./expenses.js";
import * as campaigns from "./campaigns.js";
import * as emailLists from "./email-lists.js";
import * as forms from "./forms.js";
import * as tickets from "./tickets.js";
import * as surveys from "./surveys.js";
import * as surveyResponses from "./survey-responses.js";
import * as workflowRuns from "./workflow-runs.js";
import * as goals from "./goals.js";

export const repositories = {
  contacts,
  leads,
  companies,
  deals,
  tasks,
  activities,
  products,
  quotes,
  contracts,
  orders,
  invoices,
  expenses,
  campaigns,
  emailLists,
  forms,
  tickets,
  surveys,
  surveyResponses,
  workflowRuns,
  goals,
  // The URL segment is what selects a repository, and the frontend asks for
  // `emailLists` / `surveyResponses` (helpers.js lists them camelCase too), so
  // those are the canonical keys above. The snake_case spellings are aliases
  // for the backfill script and migration tooling, which work in table names.
  email_lists: emailLists,
  survey_responses: surveyResponses,
  workflow_runs: workflowRuns,
};

/** Repository module for `resource`, or null when it is not stored in PG. */
export function repoFor(resource) {
  return repositories[resource] || null;
}

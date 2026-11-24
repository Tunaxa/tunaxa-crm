import { type FieldSpec } from "../../components/records/types";

export const leadFields: FieldSpec[] = [
  { key: "name", label: "Lead name", required: true },
  { key: "company", label: "Company" },
  { key: "email", label: "Email", type: "email" },
  { key: "phone", label: "Phone" },
  { key: "source", label: "Source" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["New", "Contacted", "Qualified", "Nurture", "Lost"],
  },
  { key: "owner", label: "Owner" },
  { key: "value", label: "Estimated value", type: "number" },
];

export const contactFields: FieldSpec[] = [
  { key: "name", label: "Contact name", required: true },
  { key: "role", label: "Job title" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email", type: "email" },
  { key: "phone", label: "Phone" },
  { key: "owner", label: "Owner" },
];

export const dealFields: FieldSpec[] = [
  { key: "title", label: "Deal name", required: true },
  { key: "company", label: "Company" },
  { key: "value", label: "Value", type: "number" },
  {
    key: "stage",
    label: "Stage",
    type: "select",
    options: ["new", "qualified", "proposal", "negotiation", "won"],
  },
  { key: "owner", label: "Owner" },
  { key: "closeDate", label: "Close date", type: "date" },
];

export const companyFields: FieldSpec[] = [
  { key: "name", label: "Company name", required: true },
  { key: "industry", label: "Industry" },
  { key: "website", label: "Website" },
  { key: "country", label: "Country" },
  { key: "employees", label: "Employees", type: "number" },
  { key: "owner", label: "Owner" },
];

export const stages = [
  { id: "new", label: "New" },
  { id: "qualified", label: "Qualified" },
  { id: "proposal", label: "Proposal" },
  { id: "negotiation", label: "Negotiation" },
  { id: "won", label: "Won" },
];

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

export const stages = [
  { id: "new", label: "New" },
  { id: "qualified", label: "Qualified" },
  { id: "proposal", label: "Proposal" },
  { id: "negotiation", label: "Negotiation" },
  { id: "won", label: "Won" },
];

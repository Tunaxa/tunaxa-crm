import { PeoplePage, type FieldSpec } from "./shared";

const leadFields: FieldSpec[] = [
  { key: "name", label: "Lead name", required: true },
  { key: "company", label: "Company" },
  { key: "email", label: "Email", type: "email" },
  { key: "phone", label: "Phone" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["New", "Contacted", "Qualified", "Lost"],
  },
  { key: "source", label: "Source" },
  { key: "owner", label: "Owner" },
  { key: "value", label: "Estimated value", type: "number" },
];

export function LeadsPage() {
  return (
    <PeoplePage
      resource="leads"
      title="Leads"
      description="Capture and qualify new opportunities."
      icon="lead"
      fields={leadFields}
    />
  );
}

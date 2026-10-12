import { PeoplePage, type FieldSpec } from "./shared";

const contactFields: FieldSpec[] = [
  { key: "name", label: "Contact name", required: true },
  { key: "role", label: "Job title" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email", type: "email" },
  { key: "phone", label: "Phone" },
  { key: "owner", label: "Owner" },
];

export function ContactsPage() {
  return (
    <PeoplePage
      resource="contacts"
      title="Contacts"
      description="Customer and prospect contact records."
      icon="contacts"
      fields={contactFields}
    />
  );
}

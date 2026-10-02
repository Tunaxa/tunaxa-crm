import type { ComponentType } from "react";

type Row = {
  id: string;
  [key: string]: any;
};

type FieldSpec = {
  key: string;
  label: string;
  type?: string;
  options?: string[];
  required?: boolean;
  placeholder?: string;
};

type ContractsPageProps = {
  CrudTablePage: ComponentType<{
    resource: string;
    title: string;
    description: string;
    icon: string;
    fields: FieldSpec[];
    nameKey: string;
    statusField: string;
    synopsis: (row: Row) => string;
    moneyColumn?: string[];
  }>;
  contractFields: FieldSpec[];
};

export function ContractsPage({
  CrudTablePage,
  contractFields,
}: ContractsPageProps) {
  return (
    <CrudTablePage
      resource="contracts"
      title="Contracts"
      description="Subscription terms, renewals and recurring revenue."
      icon="contract"
      fields={contractFields}
      nameKey="name"
      statusField="status"
      synopsis={(r) =>
        `${r.customer || ""}${r.billingFrequency ? " · " + r.billingFrequency : ""}`
      }
      moneyColumn={["value", "mrr"]}
    />
  );
}
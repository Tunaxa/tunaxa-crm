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

type InvoicesPageProps = {
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
  invoiceFields: FieldSpec[];
};

export function InvoicesPage({
  CrudTablePage,
  invoiceFields,
}: InvoicesPageProps) {
  return (
    <CrudTablePage
      resource="invoices"
      title="Invoices"
      description="Bill customers and track payments."
      icon="invoice"
      fields={invoiceFields}
      nameKey="number"
      statusField="status"
      synopsis={(r) => r.customerName || r.customerEmail || ""}
      moneyColumn={["amount", "tax"]}
    />
  );
}
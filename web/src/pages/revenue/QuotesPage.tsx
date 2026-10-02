import type { ComponentType, ReactNode } from "react";

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

type QuotesPageProps = {
  CrudTablePage: ComponentType<{
    resource: string;
    title: string;
    description: string;
    icon: string;
    fields: FieldSpec[];
    columns: FieldSpec[];
    nameKey: string;
    statusField: string;
    synopsis: (row: Row) => string;
    moneyColumn?: string[];
    renderEditor?: (props: any) => ReactNode;
  }>;
  quoteFields: FieldSpec[];
  QuoteForm: ComponentType<any>;
};

export function QuotesPage({
  CrudTablePage,
  quoteFields,
  QuoteForm,
}: QuotesPageProps) {
  return (
    <CrudTablePage
      resource="quotes"
      title="Quotes"
      description="Generate and track quotes (estimate-to-contract)."
      icon="quote"
      fields={quoteFields}
      columns={quoteFields.filter((field) =>
        ["number", "customer", "total", "status", "expiryDate"].includes(
          field.key,
        ),
      )}
      nameKey="number"
      statusField="status"
      synopsis={(r) => r.customer || r.deal || ""}
      moneyColumn={["total"]}
      renderEditor={(props) => <QuoteForm {...props} />}
    />
  );
}
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

type OrdersPageProps = {
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
  orderFields: FieldSpec[];
};

export function OrdersPage({
  CrudTablePage,
  orderFields,
}: OrdersPageProps) {
  return (
    <CrudTablePage
      resource="orders"
      title="Orders"
      description="Commerce orders, statuses and totals."
      icon="send"
      fields={orderFields}
      nameKey="orderNumber"
      statusField="status"
      synopsis={(r) => r.customer || r.email || ""}
      moneyColumn={["subtotal", "tax", "shipping", "total"]}
    />
  );
}
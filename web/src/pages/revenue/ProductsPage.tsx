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

type ProductsPageProps = {
  CrudTablePage: ComponentType<{
    resource: string;
    title: string;
    description: string;
    icon: string;
    fields: FieldSpec[];
    nameKey: string;
    statusField: string;
    synopsis: (row: Row) => string;
  }>;
  productFields: FieldSpec[];
};

export function ProductsPage({
  CrudTablePage,
  productFields,
}: ProductsPageProps) {
  return (
    <CrudTablePage
      resource="products"
      title="Products"
      description="Product catalog with pricing and inventory."
      icon="cart"
      fields={productFields}
      nameKey="name"
      statusField="status"
      synopsis={(r) => r.sku || r.category || ""}
    />
  );
}
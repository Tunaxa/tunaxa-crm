import { CrudTablePage } from "../../components/records/CrudTablePage";
import { marketingEmailFields } from "./fields";

export function MarketingEmailsPage() {
  return (
    <CrudTablePage
      resource="marketingEmails"
      title="Marketing Emails"
      description="Design, send and measure bulk email engagement."
      icon="mail"
      fields={marketingEmailFields}
      nameKey="name"
      statusField="status"
      synopsis={(row) => row.subject || row.list || ""}
    />
  );
}

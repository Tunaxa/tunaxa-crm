import { CrudTablePage } from "../../components/records/CrudTablePage";
import { emailListFields } from "./fields";

export function EmailListsPage() {
  return (
    <CrudTablePage
      resource="emailLists"
      title="Email Lists"
      description="Segmented subscriber lists for outreach."
      icon="inbox"
      fields={emailListFields}
      nameKey="name"
      statusField="status"
      synopsis={(r) => `${r.subscribers || 0} subscribers`}
    />
  );
}

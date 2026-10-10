import { CrudTablePage } from "../../components/records/CrudTablePage";
import { campaignFields } from "./fields";

export function CampaignsPage() {
  return (
    <CrudTablePage
      resource="campaigns"
      title="Campaigns"
      description="Plan and track marketing campaigns end to end."
      icon="campaign"
      fields={campaignFields}
      nameKey="name"
      statusField="status"
      synopsis={(r) => r.channel || ""}
      moneyColumn={[]}
    />
  );
}

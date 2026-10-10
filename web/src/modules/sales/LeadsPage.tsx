import { useTranslation } from "react-i18next";
import { PeoplePage } from "./PeoplePage";
import { leadFields } from "./fields";

export function LeadsPage() {
  const { t } = useTranslation();
  return <PeoplePage resource="leads" title={t("nav.leads")} description="Capture and qualify new opportunities." icon="lead" fields={leadFields} />;
}

import { useTranslation } from "react-i18next";
import { PeoplePage } from "./PeoplePage";
import { contactFields } from "./fields";

export function ContactsPage() {
  const { t } = useTranslation();
  return <PeoplePage resource="contacts" title={t("nav.contacts")} description="Customer and prospect contact records." icon="contacts" fields={contactFields} />;
}

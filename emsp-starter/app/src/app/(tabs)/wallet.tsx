import { EmptyState } from "../../components/EmptyState";
import { t } from "../../i18n";

export default function Wallet() {
  return (
    <EmptyState
      title={t("wallet.title")}
      heading={t("wallet.empty")}
      body={t("wallet.body")}
      icon="wallet"
    />
  );
}

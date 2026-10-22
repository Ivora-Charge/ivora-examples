import { router } from "expo-router";
import { Button } from "../../components/Controls";
import { EmptyState } from "../../components/EmptyState";
import { t } from "../../i18n";

export default function Charging() {
  return (
    <EmptyState
      title={t("charging.title")}
      heading={t("charging.empty")}
      body={t("charging.body")}
      icon="bolt"
    >
      <Button
        label={t("charging.find")}
        icon="map"
        onPress={() => router.navigate("/")}
      />
    </EmptyState>
  );
}

import { router, useLocalSearchParams } from "expo-router";
import { ChargerDetail } from "../../components/ChargerDetail";
import { recall } from "../../lib/recent";

/** A charger's page on phones (wide screens show it as a card beside the map). */
export default function LocationPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <ChargerDetail
      id={id}
      summary={recall(id)}
      variant="page"
      onClose={() => (router.canGoBack() ? router.back() : router.replace("/"))}
    />
  );
}

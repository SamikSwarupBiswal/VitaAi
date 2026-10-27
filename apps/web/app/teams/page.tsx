import { TeamsPage } from "@/components/teams-page";

export default async function Page({ searchParams }: { searchParams: Promise<{ account?: string | string[] }> }) {
  const { account } = await searchParams;
  const selected = typeof account === "string" ? account : "";
  return <TeamsPage initialAccount={selected} key={selected} />;
}

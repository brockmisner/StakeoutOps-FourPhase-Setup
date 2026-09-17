import { OperationsDashboard } from "@/components/operations-dashboard";
import { requirePageUser } from "@/lib/auth/page";
import { isDeploymentReady } from "@/lib/runtime-readiness";
import { isDemoMode } from "@/lib/supabase/config";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const previewMode = isDemoMode();
  if (!previewMode) await requirePageUser();
  const systemReady = !previewMode && isDeploymentReady();
  return <OperationsDashboard initialNow={new Date().toISOString()} systemReady={systemReady} />;
}

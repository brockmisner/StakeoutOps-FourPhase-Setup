import { Suspense } from "react";
import { redirect } from "next/navigation";

import { arePublicSignupsAllowed } from "@/lib/auth/signup-policy";
import { AuthForm } from "../auth-form";

export default function SignupPage() {
  if (!arePublicSignupsAllowed()) {
    redirect("/login?invitation=required");
  }

  return (
    <Suspense fallback={null}>
      <AuthForm mode="signup" />
    </Suspense>
  );
}

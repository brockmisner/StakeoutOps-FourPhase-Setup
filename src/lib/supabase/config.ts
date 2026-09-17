function browserValues() {
  return {
    publicUrl: process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(),
    publishableKey:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim(),
  };
}

export function hasSupabaseBrowserConfig(): boolean {
  const { publicUrl, publishableKey } = browserValues();
  return Boolean(publicUrl && publishableKey);
}

export function hasSupabaseServerConfig(): boolean {
  const { publicUrl, publishableKey } = browserValues();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  return Boolean(publicUrl && publishableKey && secretKey);
}

export function isDemoMode(): boolean {
  return (
    process.env.NEXT_PUBLIC_DEMO_MODE === "true" &&
    !hasSupabaseBrowserConfig()
  );
}

export function getSupabaseBrowserConfig(): {
  url: string;
  publishableKey: string;
} {
  const { publicUrl, publishableKey } = browserValues();
  if (!publicUrl || !publishableKey) {
    throw new Error("Supabase browser configuration is missing.");
  }

  return { url: publicUrl, publishableKey };
}

export function getSupabaseServerConfig(): {
  url: string;
  publishableKey: string;
  secretKey: string;
} {
  const { publicUrl, publishableKey } = browserValues();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!publicUrl || !publishableKey || !secretKey) {
    throw new Error("Supabase server configuration is missing.");
  }

  return { url: publicUrl, publishableKey, secretKey };
}

/// <reference types="vite/client" />

// Community features are configured through these. Both absent is the
// supported offline state — see src/community.ts.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }

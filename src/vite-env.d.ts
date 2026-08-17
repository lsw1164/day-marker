/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Public by design — this ships in the bundle and is not a secret. Optional
   * because a checkout without `.env.local` genuinely has no value here, which is
   * the case `createAuth`'s MISSING_CLIENT_ID sentinel exists to report.
   */
  readonly VITE_GOOGLE_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

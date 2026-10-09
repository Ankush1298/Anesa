/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Same-origin path prefix under which the reverse proxy exposes the API. Default "/api". */
  readonly VITE_API_BASE_PATH?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

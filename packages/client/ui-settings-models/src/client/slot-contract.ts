/** Models-page extension slots for adapter-owned sign-in and supplementary UI. */

import type { ConfigurableProviderView } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Adapter extension area on every provider card, keyed by settings namespace. */
    'settings.models.provider-card': {
      kind: 'keyed'
      scope: 'root'
      owner: ProviderCardExtrasOwnerProps
    }
    /** Ordered extension area after the provider list and add controls. */
    'settings.models.footer': { kind: 'list'; scope: 'root'; owner: ModelsFooterOwnerProps }
  }
}

/** Owner share of one provider-card extension occurrence. */
export interface ProviderCardExtrasOwnerProps {
  /** Directory row describing the route and its owning settings namespace. */
  provider: ConfigurableProviderView
  /** Whether any settings layer configures the provider. */
  configured: boolean
  /** Whether the row's conventional or explicit API-key reference is configured. */
  keyConfigured: boolean
}

/** Owner share of the footer extension area. */
export interface ModelsFooterOwnerProps {
  /** Marker field: footer owner props are intentionally empty. */
  children?: never
}

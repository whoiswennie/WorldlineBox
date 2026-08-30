/** Account profile capability shared inside the active Host runtime. */

/** Identity fields allowed to cross the current-tenant account-authority seam inside Host. */
export interface AccountProfileSnapshot {
  id: number
  username: string
  createdAt: number
  lastLoginAt: number | null
  displayName: string
  avatar: string
  /**
   * Host-local materialization of the current avatar. This path is intended
   * only for model tools such as `read_image`; browser API projections must
   * continue to expose `avatar` and never serialize this host path.
   */
  avatarPath?: string
  bio: string
}

/** Read-only view of the active account tenant. */
export interface AccountProfile {
  /**
   * Read the browser-safe profile for the account currently owning this runtime.
   * @returns the active public profile, or undefined when no account is available.
   */
  current(): AccountProfileSnapshot | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Current-tenant profile, including an optional Host-only avatar path. */
    localAccountProfile: AccountProfile
  }
}

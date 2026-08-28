/** Browser-safe account profile capability shared by providers and consumers. */

/** Public identity fields allowed to cross the account-authority seam. */
export interface AccountProfileSnapshot {
  id: number
  username: string
  createdAt: number
  lastLoginAt: number | null
  displayName: string
  avatar: string
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
    /** Browser-safe profile for the active account-scoped runtime. */
    localAccountProfile: AccountProfile
  }
}

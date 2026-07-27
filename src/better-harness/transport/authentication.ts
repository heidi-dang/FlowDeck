export interface AuthConfig {
  token: string | null;
  enabled: boolean;
}

export function createAuthCheck(config: AuthConfig): (token?: string) => boolean {
  if (!config.enabled || !config.token) {
    return () => true;
  }

  return (token?: string): boolean => {
    if (!token) return false;
    return token === config.token;
  };
}

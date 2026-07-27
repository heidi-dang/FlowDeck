export interface AuthConfig {
  token: string | null;
  enabled: boolean;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function createAuthCheck(config: AuthConfig): (token?: string) => boolean {
  if (!config.enabled || !config.token) {
    return () => true;
  }

  const expectedToken = config.token;

  return (token?: string): boolean => {
    if (!token) return false;
    return constantTimeEqual(token, expectedToken);
  };
}

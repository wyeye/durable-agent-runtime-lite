export class MockServerState {
  private readonly attempts = new Map<string, number>();
  businessApiRequestCount = 0;
  lastBusinessApiAuthorization: string | undefined;
  currentScenario: string | undefined;

  incrementAttempt(key: string): number {
    const next = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, next);
    return next;
  }

  setScenario(scenario: string | undefined): void {
    this.currentScenario = scenario && scenario.trim().length > 0 ? scenario : undefined;
  }

  resetBusinessApi(): void {
    this.businessApiRequestCount = 0;
    this.lastBusinessApiAuthorization = undefined;
    this.attempts.delete('business_api_rate_limit_then_success');
  }

  reset(): void {
    this.attempts.clear();
    this.businessApiRequestCount = 0;
    this.lastBusinessApiAuthorization = undefined;
    this.currentScenario = undefined;
  }

  stats(): Record<string, unknown> {
    return {
      current_scenario: this.currentScenario ?? null,
      business_api_request_count: this.businessApiRequestCount,
      last_business_api_authorization: this.lastBusinessApiAuthorization === 'Bearer business-read-secret'
        ? 'bearer_ok'
        : 'invalid_or_missing',
      attempts: Object.fromEntries(this.attempts.entries()),
    };
  }
}

export const mockState = new MockServerState();

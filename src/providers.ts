type Result = { status: 'ok'; request_id: string; code: string } | { status: 'error'; reason: string };
export type ProviderConfig = { failRate: number; timeoutRate: number; delayMs: number };
export class StubProvider {
  private issued = new Map<string, string>();
  private stock: string[];
  constructor(public readonly name: string, private config: ProviderConfig = { failRate: 0, timeoutRate: 0, delayMs: 0 }) { this.stock = this.makeStock(); }
  setConfig(config: Partial<ProviderConfig>) { this.config = { ...this.config, ...config }; }
  private makeStock() { return Array.from({ length: 50 }, (_, i) => `${this.name}-KEY-${String(i + 1).padStart(3, '0')}`); }
  reset() { this.issued.clear(); this.stock = this.makeStock(); }
  async issue(request_id: string, sku: string, order_id: string): Promise<Result> {
    const existing = this.issued.get(request_id); if (existing) return { status: 'ok', request_id, code: existing };
    if (this.config.delayMs) await new Promise(r => setTimeout(r, this.config.delayMs));
    if (Math.random() < this.config.failRate) return { status: 'error', reason: 'provider_error' };
    const code = this.stock.shift(); if (!code) return { status: 'error', reason: 'out_of_stock' };
    this.issued.set(request_id, code);
    if (Math.random() < this.config.timeoutRate) await new Promise(() => {});
    return { status: 'ok', request_id, code };
  }
}
export const providers = { A: new StubProvider('A'), B: new StubProvider('B') };

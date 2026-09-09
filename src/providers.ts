export type ProviderResult =
  | { status: 'ok'; request_id: string; code: string }
  | { status: 'error'; reason: string };

export type ProviderRecord = {
  request_id: string;
  code: string;
  sku: string;
  order_id: string;
  provider: string;
  issued_at: string;
};

export type ProviderConfig = {
  failRate: number;
  timeoutRate: number;
  delayMs: number;
  duplicateRate: number;
  wrongSkuRate: number;
  errorAfterIssueRate: number;
  duplicateNext: boolean;
  wrongSkuNext: boolean;
  errorAfterIssueNext: boolean;
};

const defaults: ProviderConfig = {
  failRate: 0,
  timeoutRate: 0,
  delayMs: 0,
  duplicateRate: 0,
  wrongSkuRate: 0,
  errorAfterIssueRate: 0,
  duplicateNext: false,
  wrongSkuNext: false,
  errorAfterIssueNext: false,
};

export class StubProvider {
  private issued = new Map<string, ProviderRecord>();
  private inFlight = new Map<string, Promise<ProviderResult>>();
  private stock: string[];
  private requestTimes: number[] = [];

  constructor(
    public readonly name: string,
    private config: ProviderConfig = { ...defaults },
  ) {
    this.stock = this.makeStock();
  }

  setConfig(config: Partial<ProviderConfig>) {
    this.config = { ...this.config, ...config };
  }

  getConfig(): ProviderConfig {
    return { ...this.config };
  }

  private makeStock() {
    return Array.from(
      { length: 50 },
      (_, index) => `${this.name}-KEY-${String(index + 1).padStart(3, '0')}`,
    );
  }

  reset() {
    this.issued.clear();
    this.inFlight.clear();
    this.stock = this.makeStock();
    this.requestTimes = [];
    this.config = { ...defaults };
  }

  metrics(since = 0) {
    return {
      requests: this.requestTimes.filter(timestamp => timestamp >= since).length,
      issued: this.issued.size,
    };
  }

  async lookup(requestId: string): Promise<ProviderRecord | null> {
    const record = this.issued.get(requestId);
    return record ? { ...record } : null;
  }

  private consumeOnce(key: 'duplicateNext' | 'wrongSkuNext' | 'errorAfterIssueNext') {
    if (!this.config[key]) return false;
    this.config[key] = false;
    return true;
  }

  issue(request_id: string, sku: string, order_id: string): Promise<ProviderResult> {
    this.requestTimes.push(Date.now());

    // A retry with the same request id can never consume another code.
    const existing = this.issued.get(request_id);
    if (existing) return Promise.resolve({ status: 'ok', request_id, code: existing.code });
    const inFlight = this.inFlight.get(request_id);
    if (inFlight) return inFlight;

    const operation = this.issueOnce(request_id, sku, order_id);
    this.inFlight.set(request_id, operation);
    void operation.finally(() => {
      if (this.inFlight.get(request_id) === operation) this.inFlight.delete(request_id);
    });
    return operation;
  }

  private async issueOnce(request_id: string, sku: string, order_id: string): Promise<ProviderResult> {

    if (this.config.delayMs) {
      await new Promise(resolve => setTimeout(resolve, this.config.delayMs));
    }

    if (Math.random() < this.config.failRate) {
      return { status: 'error', reason: 'provider_error' };
    }

    const duplicate = this.consumeOnce('duplicateNext') || Math.random() < this.config.duplicateRate;
    const previous = [...this.issued.values()][0];
    const code = duplicate && previous ? previous.code : this.stock.shift();
    if (!code) return { status: 'error', reason: 'out_of_stock' };

    const wrongSku = this.consumeOnce('wrongSkuNext') || Math.random() < this.config.wrongSkuRate;
    const record: ProviderRecord = {
      request_id,
      code,
      sku: wrongSku ? `FOREIGN-${sku}` : sku,
      order_id,
      provider: this.name,
      issued_at: new Date().toISOString(),
    };
    this.issued.set(request_id, record);

    if (this.config.timeoutRate > 0 && Math.random() < this.config.timeoutRate) {
      await new Promise<never>(() => undefined);
    }

    const errorAfterIssue =
      this.consumeOnce('errorAfterIssueNext') || Math.random() < this.config.errorAfterIssueRate;
    if (errorAfterIssue) {
      return { status: 'error', reason: 'provider_error' };
    }

    return { status: 'ok', request_id, code };
  }
}

export const providers = {
  A: new StubProvider('A'),
  B: new StubProvider('B'),
};

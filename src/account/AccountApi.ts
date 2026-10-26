import type { OlxHttpClient } from '../http/HttpClient.js';
import type { ListingsApi } from '../listings/ListingsApi.js';
import { parsePackageOffers, parseWallet, type PackageOffer, type Wallet } from '../listings/olxResponses.js';
import type { AccountInfo } from '../listings/types.js';

/** Your OLX account: profile, wallet and package offers. Read only: the SDK never buys or spends. */
export class AccountApi {
  constructor(
    private readonly http: OlxHttpClient,
    private readonly listings: ListingsApi,
  ) {}

  /** The signed-in account: its public id, display name and phone. */
  profile(): Promise<AccountInfo> {
    return this.listings.getAccount();
  }

  /** Prepaid credit on the account, in USD. */
  async wallet(): Promise<Wallet> {
    return parseWallet(await this.http.call('wallet'));
  }

  /**
   * What OLX charges to post past the free limit in a category (for ads that come back
   * `limited`). Prices are in USD. Read only.
   */
  async postingLimitOffers(categoryId: string | number): Promise<PackageOffer[]> {
    return parsePackageOffers(await this.http.call('postingLimitOffers', { params: { categoryId: String(categoryId) } }));
  }
}

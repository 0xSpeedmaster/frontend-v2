import { GasPriceService } from '@/services/gas-price/gas-price.service';
import { Pool } from '@/services/pool/types';
import { BalancerSDK, PoolWithMethods } from '@balancer-labs/sdk';
import { TransactionResponse } from '@ethersproject/abstract-provider';
import { Ref } from 'vue';
import { JoinParams, JoinPoolHandler, QueryOutput } from './join-pool.handler';
import { formatFixed, parseFixed } from '@ethersproject/bignumber';
import {
  bnum,
  findByAddress,
  formatAddressForSor,
  isSameAddress,
  selectByAddress,
} from '@/lib/utils';
import { TransactionBuilder } from '@/services/web3/transactions/transaction.builder';
import { NATIVE_ASSET_ADDRESS, TOKENS } from '@/constants/tokens';

/**
 * Handles joins with pool tokens using SDK functions.
 */
export class ExactInJoinHandler implements JoinPoolHandler {
  private lastJoinRes?: ReturnType<PoolWithMethods['buildJoin']>;

  constructor(
    public readonly pool: Ref<Pool>,
    public readonly sdk: BalancerSDK,
    public readonly gasPriceService: GasPriceService
  ) {}

  async join(params: JoinParams): Promise<TransactionResponse> {
    await this.queryJoin(params);
    console.log('his.lastJoinRes', this.lastJoinRes);
    if (!this.lastJoinRes) {
      throw new Error('Could not query generalised join');
    }

    const txBuilder = new TransactionBuilder(params.signer);
    const { to, data, value } = this.lastJoinRes;
    console.log('value', Number(value));

    // value property must be passed if joining with native asset
    return txBuilder.raw.sendTransaction({ to, data, value });
  }

  async queryJoin({
    amountsIn,
    tokensIn,
    signer,
    slippageBsp,
  }: JoinParams): Promise<QueryOutput> {
    const addressesIn = amountsIn.map(({ address }) => address);
    const tokensList: string[] = this.swapEthAddressToWeth(
      addressesIn,
      this.pool.value.tokensList
    );
    const evmAmountsIn: string[] = tokensList.map(address => {
      const token = selectByAddress(tokensIn, address);

      if (!token) return '0';

      const value = findByAddress(amountsIn, address)?.value;
      return parseFixed(value || '0', token.decimals).toString();
    });

    const signerAddress = await signer.getAddress();
    const slippage = slippageBsp.toString();
    const sdkPool = await this.sdk.pools.find(this.pool.value.id);

    if (!sdkPool) throw new Error('Failed to find pool: ' + this.pool.value.id);
    const tokensListForSor = tokensList.map(address =>
      formatAddressForSor(address)
    );

    this.lastJoinRes = sdkPool.buildJoin(
      signerAddress,
      tokensListForSor,
      evmAmountsIn,
      slippage
    );

    if (!this.lastJoinRes) {
      throw new Error('Failed to fetch expected output.');
    }

    const { expectedBPTOut } = this.lastJoinRes;
    if (bnum(expectedBPTOut).eq(0))
      throw new Error('Failed to fetch expected output.');

    const bptOut = formatFixed(
      expectedBPTOut,
      this.pool.value.onchain?.decimals || 18
    );

    const evmPriceImpact = await sdkPool.calcPriceImpact(
      evmAmountsIn,
      expectedBPTOut,
      true
    );

    const priceImpact = Number(formatFixed(evmPriceImpact, 18));

    return {
      bptOut,
      priceImpact,
    };
  }

  // If tokenAddressesIn contains NATIVE_ASSET_ADDRESS, replace it with the wrapped native asset address
  // while keeping the original poolTokens order
  private swapEthAddressToWeth(
    tokenAddressesIn: string[],
    poolTokens: string[]
  ): string[] {
    const hasNativeAsset = tokenAddressesIn.some(address =>
      isSameAddress(address, NATIVE_ASSET_ADDRESS)
    );
    if (hasNativeAsset) {
      // Switch the wrapped native asset address for the native asset address
      return poolTokens.map(address =>
        isSameAddress(address, TOKENS.Addresses.wNativeAsset)
          ? NATIVE_ASSET_ADDRESS
          : address
      );
    }
    return poolTokens;
  }
}

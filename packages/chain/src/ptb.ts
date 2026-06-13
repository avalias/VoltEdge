/**
 * PTB builders for DeepBook Predict (testnet). Each function appends
 * moveCalls to a Transaction and returns intermediate results where
 * composition makes sense. Scales: strikes/prices 1e9, quantities 1e6.
 *
 * Verified against workshop scripts (predict_workshop/*.ts) and
 * packages/predict/sources/predict.move signatures.
 */
import { Transaction, type TransactionResult } from '@mysten/sui/transactions';
import {
  CLOCK_OBJECT_ID,
  DUSDC_TYPE,
  PREDICT_OBJECT_ID,
  PREDICT_PACKAGE_ID,
} from './constants.js';

export interface MarketKeyArgs {
  oracleId: string;
  expiryMs: bigint;
  /** strike in 1e9 fixed point (dollars * 1e9), already grid-snapped */
  strike: bigint;
  isUp: boolean;
}

export interface RangeKeyArgs {
  oracleId: string;
  expiryMs: bigint;
  lowerStrike: bigint;
  higherStrike: bigint;
}

/** market_key::up / ::down — constructs the position key on-chain. */
export function buildMarketKey(tx: Transaction, k: MarketKeyArgs): TransactionResult {
  return tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::market_key::${k.isUp ? 'up' : 'down'}`,
    arguments: [tx.pure.id(k.oracleId), tx.pure.u64(k.expiryMs), tx.pure.u64(k.strike)],
  });
}

export function buildRangeKey(tx: Transaction, k: RangeKeyArgs): TransactionResult {
  return tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::range_key::new`,
    arguments: [
      tx.pure.id(k.oracleId),
      tx.pure.u64(k.expiryMs),
      tx.pure.u64(k.lowerStrike),
      tx.pure.u64(k.higherStrike),
    ],
  });
}

/** predict::create_manager — one shared PredictManager per user. */
export function buildCreateManager(tx: Transaction): void {
  tx.moveCall({ target: `${PREDICT_PACKAGE_ID}::predict::create_manager`, arguments: [] });
}

/**
 * Merge sender's dUSDC coins and deposit `amount` (1e6 units) into the
 * manager. coinIds must belong to the sender; first is the primary.
 */
export function buildDeposit(
  tx: Transaction,
  managerId: string,
  coinIds: string[],
  amount: bigint,
): void {
  const first = coinIds[0];
  if (!first) throw new Error('no dUSDC coins to deposit');
  const primary = tx.object(first);
  if (coinIds.length > 1) {
    tx.mergeCoins(primary, coinIds.slice(1).map((id) => tx.object(id)));
  }
  const [depositCoin] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict_manager::deposit`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(managerId), depositCoin!],
  });
}

function buildTrade(
  tx: Transaction,
  fn: 'mint' | 'redeem' | 'redeem_permissionless',
  managerId: string,
  oracleId: string,
  key: TransactionResult,
  quantity: bigint,
): void {
  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::${fn}`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(PREDICT_OBJECT_ID),
      tx.object(managerId),
      tx.object(oracleId),
      key,
      tx.pure.u64(quantity),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
}

/** predict::mint — buy a binary; cost debited from manager balance. */
export function buildMint(
  tx: Transaction,
  managerId: string,
  k: MarketKeyArgs,
  quantity: bigint,
): void {
  buildTrade(tx, 'mint', managerId, k.oracleId, buildMarketKey(tx, k), quantity);
}

/** predict::redeem — owner-only, live (pre-settlement) or settled. */
export function buildRedeem(
  tx: Transaction,
  managerId: string,
  k: MarketKeyArgs,
  quantity: bigint,
): void {
  buildTrade(tx, 'redeem', managerId, k.oracleId, buildMarketKey(tx, k), quantity);
}

/** predict::redeem_permissionless — settled oracles only, any sender. */
export function buildRedeemPermissionless(
  tx: Transaction,
  managerId: string,
  k: MarketKeyArgs,
  quantity: bigint,
): void {
  buildTrade(tx, 'redeem_permissionless', managerId, k.oracleId, buildMarketKey(tx, k), quantity);
}

function buildRangeTrade(
  tx: Transaction,
  fn: 'mint_range' | 'redeem_range',
  managerId: string,
  k: RangeKeyArgs,
  quantity: bigint,
): void {
  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::${fn}`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(PREDICT_OBJECT_ID),
      tx.object(managerId),
      tx.object(k.oracleId),
      buildRangeKey(tx, k),
      tx.pure.u64(quantity),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
}

/** predict::mint_range — vertical spread paying $1 on (lower, higher]. */
export function buildMintRange(
  tx: Transaction,
  managerId: string,
  k: RangeKeyArgs,
  quantity: bigint,
): void {
  buildRangeTrade(tx, 'mint_range', managerId, k, quantity);
}

/** predict::redeem_range — owner-only; handles live and settled states. */
export function buildRedeemRange(
  tx: Transaction,
  managerId: string,
  k: RangeKeyArgs,
  quantity: bigint,
): void {
  buildRangeTrade(tx, 'redeem_range', managerId, k, quantity);
}

/** predict::supply — LP deposit, returns Coin<PLP> transferred to recipient. */
export function buildSupply(
  tx: Transaction,
  coinIds: string[],
  amount: bigint,
  recipient: string,
): void {
  const first = coinIds[0];
  if (!first) throw new Error('no dUSDC coins to supply');
  const primary = tx.object(first);
  if (coinIds.length > 1) {
    tx.mergeCoins(primary, coinIds.slice(1).map((id) => tx.object(id)));
  }
  const [supplyCoin] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
  const [lpCoin] = tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::supply`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(PREDICT_OBJECT_ID), supplyCoin!, tx.object(CLOCK_OBJECT_ID)],
  });
  tx.transferObjects([lpCoin!], tx.pure.address(recipient));
}

/** predict::withdraw — burn PLP coin, receive dUSDC. */
export function buildWithdraw(tx: Transaction, plpCoinId: string, recipient: string): void {
  const [out] = tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::withdraw`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(PREDICT_OBJECT_ID), tx.object(plpCoinId), tx.object(CLOCK_OBJECT_ID)],
  });
  tx.transferObjects([out!], tx.pure.address(recipient));
}

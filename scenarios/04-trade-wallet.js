// Scenario 9.4 — Trade (Any Token) via Wallet
// Covers: list/get secondary assets, resolve secondary account + broker id,
// trading eligibility gate, price history, depth of book, market/order
// status, portfolio wallet balances, holder-limit buy gate, available
// purchase quantity, trade fee estimate, idempotency key, place order,
// cancel order.
//
// Every endpoint/payload below is confirmed against the real frontend's own
// API client (packages/api-client/src/domains/secondary + wallet,
// 2026-08-21) except POST /orders/idempotent/key's response shape, which
// even the frontend's own contracts file marks as unconfirmed -- handled
// defensively below.
//
// Requires a pool of already onboarded, trading-eligible accounts — seeded
// separately via scenarios/00b-seed-onboarded-pool.js (the general
// TEST_USER_POOL_* pool is signed-up-only and 404s on account resolution).
// This scenario places a real order and immediately cancels it in staging on
// every run — coordinate with whoever owns the order book / test-data
// cleanup before running at full 500-VU scale.
//
// Run:
//   k6 run -e TEST_TYPE=load   -e BASE_URL=https://... scenarios/04-trade-wallet.js
//   k6 run -e TEST_TYPE=stress -e BASE_URL=https://... scenarios/04-trade-wallet.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { url, jsonHeaders } from '../lib/http.js';
import { buildOptions, thresholdMs } from '../lib/options.js';
import { signIn, verifyTotp, resolveAccountIds } from '../lib/auth.js';
import { pickOnboardedPooledUser, pickOnboardedEntityPooledUser } from '../lib/users.js';
import { buildSummary } from '../lib/report.js';
import {
  SLEEP_SECONDS,
  TRADE_QUANTITY,
  TRADE_SIDE,
  TRADE_ORDER_TYPE,
  TRADE_TIME_IN_FORCE,
  DEFAULT_TRADE_PRICE,
  POOL_ACCOUNT_TYPE,
} from '../config/environment.js';

export const options = buildOptions({
  // Every tagged step gets a threshold -- k6 only keeps a separate per-step
  // breakdown metric (shown in the report's "Response time by step" table)
  // for tags referenced by a threshold, so without this only the 2 below
  // would show their own numbers even though all 16 calls in this flow are
  // individually tagged.
  'http_req_duration{name:SignIn}': [thresholdMs('SIGNIN_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:Verify2FACode}': [thresholdMs('VERIFY_2FA_CODE_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:ListSecondaryAssets}': [thresholdMs('LIST_SECONDARY_ASSETS_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:GetSecondaryAssetDetail}': [thresholdMs('GET_SECONDARY_ASSET_DETAIL_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:ResolveSecondaryAccount}': [thresholdMs('RESOLVE_SECONDARY_ACCOUNT_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:GetSecondaryAccountDetail}': [thresholdMs('GET_SECONDARY_ACCOUNT_DETAIL_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:ResolveAccountIds}': [thresholdMs('RESOLVE_ACCOUNT_IDS_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:TradingEligibilityGate}': [thresholdMs('TRADING_ELIGIBILITY_GATE_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:GetPriceHistory}': [thresholdMs('GET_PRICE_HISTORY_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:GetDepthOfBook}': [thresholdMs('GET_DEPTH_OF_BOOK_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:GetOrderStatus}': [thresholdMs('GET_ORDER_STATUS_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:GetPortfolioBalances}': [thresholdMs('GET_PORTFOLIO_BALANCES_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:HolderLimitBuyGate}': [thresholdMs('HOLDER_LIMIT_BUY_GATE_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:AvailablePurchaseQuantity}': [thresholdMs('AVAILABLE_PURCHASE_QUANTITY_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:EstimateTradeFee}': [thresholdMs('ESTIMATE_TRADE_FEE_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:CreateIdempotencyKey}': [thresholdMs('CREATE_IDEMPOTENCY_KEY_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:PlaceOrder}': [thresholdMs('PLACE_ORDER_P95_THRESHOLD_MS', 1000)],
  'http_req_duration{name:CancelOrder}': [thresholdMs('CANCEL_ORDER_P95_THRESHOLD_MS', 1000)],
});

const API_LIST = [
  { step: '1. Sign in + verify 2FA', method: 'POST', endpoint: '/auth/login, /auth/2fa/verify/{code}', description: 'Authenticates the pooled account' },
  { step: '2. List / get secondary asset', method: 'GET', endpoint: '/assets, /assets/{id}', description: 'Lists tradable tokens and reads one in detail' },
  { step: '3. Resolve secondary account', method: 'GET', endpoint: '/pi/v3/accounts, /accounts/{id}', description: 'Resolves the trading account and broker ID' },
  { step: '4. Trading eligibility gate', method: 'GET', endpoint: '/uap/v1/accounts/{id}/trading-status', description: 'Confirms the account can trade' },
  { step: '5. Price history / depth of book', method: 'GET', endpoint: '/mdt/pricehistory/{symbol}, /mdt/book/depth/{symbol}', description: 'Reads market data' },
  { step: '6. Market/order status', method: 'GET', endpoint: '/orders/status', description: 'Confirms the market is accepting orders' },
  { step: '7. Portfolio balances', method: 'GET', endpoint: '/wallets/balances/portfolios', description: 'Reads wallet balances' },
  { step: '8. Holder-limit / available-quantity gates', method: 'GET', endpoint: '/wallet/manager/deposit/canBuy, /wallets/apqs/{symbol}', description: 'Pre-order eligibility checks' },
  { step: '9. Estimate trade fee', method: 'GET', endpoint: '/fee', description: 'Quotes the trade fee' },
  { step: '10. Create idempotency key', method: 'POST', endpoint: '/orders/idempotent/key', description: 'Required token for placing the order' },
  { step: '11. Place order', method: 'POST', endpoint: '/orders', description: 'Submits the order' },
  { step: '12. Cancel order', method: 'POST', endpoint: '/orders/{id}/cancel', description: 'Teardown so the run doesn’t accumulate live orders' },
];

export function handleSummary(data) {
  return buildSummary('trade-wallet', data, API_LIST);
}

// FIX-protocol codes the real order-ticket sends on the wire (see
// packages/utils/src/trading.ts in the frontend repo) -- TRADE_SIDE/
// TRADE_ORDER_TYPE/TRADE_TIME_IN_FORCE (config) pick the human-readable
// value; these maps translate it.
const SIDE_TO_FIX = { BUY: '1', SELL: '2' };
const ORDER_TYPE_TO_FIX = { MARKET: '1', LIMIT: '2', STOP: '3', STOP_LIMIT: '4' };
const TIME_IN_FORCE_TO_FIX = { DAY: '0', GTC: '1', GTD: '6' };

export default function () {
  // MIXED: odd VUs -> Individual pool, even VUs -> Entity pool -- each VU
  // still lands on a distinct pooled account within its half.
  const useEntity = POOL_ACCOUNT_TYPE === 'MIXED' ? __VU % 2 === 0 : POOL_ACCOUNT_TYPE === 'ENTITY';
  const user = useEntity ? pickOnboardedEntityPooledUser() : pickOnboardedPooledUser();
  if (!user.totpSecret) {
    console.error(
      `No TOTP secret for ${user.email} — seed the onboarded pool first (scenarios/00b-seed-onboarded-pool.js, or scenarios/00c-seed-onboarded-entity-pool.js for POOL_ACCOUNT_TYPE=ENTITY/MIXED).`
    );
    return;
  }

  // 1. Sign in + TOTP verify
  if (!signIn(user)) {
    sleep(SLEEP_SECONDS);
    return;
  }
  sleep(SLEEP_SECONDS);
  if (!verifyTotp(user.totpSecret)) {
    sleep(SLEEP_SECONDS);
    return;
  }
  sleep(SLEEP_SECONDS);

  // 2. List secondary-market assets. Response is Spring-style pagination
  // ({ assets: [...], totalPages, ... }), not a bare array -- and each
  // item's id field is `assetId`, not `id`.
  let res = http.get(url('/assets?solution=SECONDARY_TRADING'), {
    headers: jsonHeaders(),
    tags: { name: 'ListSecondaryAssets' },
  });
  const listOk = check(res, { 'list secondary assets ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!listOk) return;

  const assets = res.json('assets') || [];
  const assetId = assets[0] && assets[0].assetId;
  if (!assetId) return;

  // 3. Get secondary asset detail.
  res = http.get(url(`/assets/${assetId}`), { headers: jsonHeaders(), tags: { name: 'GetSecondaryAssetDetail' } });
  check(res, { 'get secondary asset detail ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  const assetDetail = res.json();
  const symbol = assetDetail.symbol;
  if (!symbol) return;

  // 4. Resolve the secondary trading account -- same /pi/v3/accounts list
  // used by Invest via Wire, filtered to the Secondary Trading silo instead
  // of Primary Issuance.
  res = http.get(url('/pi/v3/accounts'), { headers: jsonHeaders(), tags: { name: 'ResolveSecondaryAccount' } });
  const resolveOk = check(res, { 'resolve secondary account ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!resolveOk) return;

  const secondaryAccounts = res.json('accounts') || [];
  const secondaryAccount = secondaryAccounts.find((a) => a.businessSilo === 'Secondary Trading');
  const secondaryAccountId = secondaryAccount && secondaryAccount.accountId;
  if (!secondaryAccountId) return;

  // 5. Get secondary account detail -- the only source of brokerId, which
  // the balance/APQ calls below require.
  res = http.get(url(`/accounts/${secondaryAccountId}`), {
    headers: jsonHeaders(),
    tags: { name: 'GetSecondaryAccountDetail' },
  });
  check(res, { 'get secondary account detail ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  const brokerId = res.json('brokerId');

  // 6. Trading eligibility gate -- keyed on the UAP uuid (a mirror id 403s
  // here, same gotcha as the Invest via Wire profile endpoints), and
  // assetType is the fixed 'GENERAL' value the real secondary trade flow
  // always sends (secondary listings aren't narrowed to a regulatory
  // exemption the way primary offerings are). Gate policy is `canTrade`,
  // not `success` (that field means something different on this endpoint).
  const accountIds = resolveAccountIds();
  if (!accountIds || !accountIds.uapAccountId) return;
  res = http.get(
    url(`/uap/v1/accounts/${accountIds.uapAccountId}/trading-status?platform=secondary&assetType=GENERAL`),
    { headers: jsonHeaders(), tags: { name: 'TradingEligibilityGate' } }
  );
  check(res, { 'trading eligibility gate ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 7. Get price history
  res = http.get(url(`/mdt/pricehistory/${symbol}`), { headers: jsonHeaders(), tags: { name: 'GetPriceHistory' } });
  check(res, { 'get price history ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 8. Get depth of book -- response is a flat array of { side, price, ... }
  // entries, not a { bids, asks } object; the live ask is the first
  // side === 'ASK' entry.
  res = http.get(url(`/mdt/book/depth/${symbol}?asksort=price_asc&bidsort=price_desc`), {
    headers: jsonHeaders(),
    tags: { name: 'GetDepthOfBook' },
  });
  check(res, { 'get depth of book ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  // Prefer the live ASK; if the book has no ASK side (thin/empty book),
  // fall back to the best BID before the hardcoded default -- a real quote
  // from either side of this same confirmed depth-of-book shape is much
  // closer to true market price than DEFAULT_TRADE_PRICE, and staying on
  // this endpoint's already-confirmed shape avoids guessing at
  // GetPriceHistory's response fields, which are never parsed/confirmed
  // anywhere in this codebase. DEFAULT_TRADE_PRICE remains the last resort
  // for a genuinely empty book (no ASK and no BID).
  const depth = res.json() || [];
  const bestAsk = depth.find((entry) => entry.side === 'ASK');
  const bestBid = depth.find((entry) => entry.side === 'BID');
  const price = (bestAsk && bestAsk.price) || (bestBid && bestBid.price) || DEFAULT_TRADE_PRICE;

  // 9. Get market/order status -- must be scoped to this assetId, or the
  // trade-service answers with default STX hours regardless of the asset's
  // actual venue.
  res = http.get(url(`/orders/status?assetId=${assetId}`), { headers: jsonHeaders(), tags: { name: 'GetOrderStatus' } });
  const orderStatusOk = check(res, { 'get order status ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!orderStatusOk) return;
  if (!res.json('ordersOpen')) {
    // Market closed (e.g. weekend/after-hours) is a legitimate, expected
    // state -- not a failure -- but it does mean PlaceOrder/CancelOrder
    // never run this iteration, so say why rather than failing silently.
    console.log(`Market closed for ${symbol} (ordersOpen=false) -- skipping order placement this iteration.`);
    return;
  }

  // 10. Get portfolio wallet balances
  res = http.get(url(`/wallets/balances/portfolios?accountId=${secondaryAccountId}&brokerId=${brokerId}`), {
    headers: jsonHeaders(),
    tags: { name: 'GetPortfolioBalances' },
  });
  check(res, { 'get portfolio balances ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 11. Holder-limit buy gate -- param is `asset` (the symbol, not the id);
  // response is the single cryptic key { r: boolean }.
  res = http.get(url(`/wallet/manager/deposit/canBuy?asset=${symbol}`), {
    headers: jsonHeaders(),
    tags: { name: 'HolderLimitBuyGate' },
  });
  check(res, { 'holder-limit buy gate ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);

  // 12. Available purchase quantity (BUY side only, per the real app).
  if (TRADE_SIDE === 'BUY') {
    res = http.get(url(`/wallets/apqs/${symbol}?accountId=${secondaryAccountId}&brokerId=${brokerId}`), {
      headers: jsonHeaders(),
      tags: { name: 'AvailablePurchaseQuantity' },
    });
    check(res, { 'available purchase quantity ok': (r) => r.status === 200 });
    sleep(SLEEP_SECONDS);
  }

  // 13. Estimate trade fee -- only a real quote when status is 'success'.
  res = http.get(url(`/fee?price=${price}&quantity=${TRADE_QUANTITY}&assetId=${assetId}`), {
    headers: jsonHeaders(),
    tags: { name: 'EstimateTradeFee' },
  });
  check(res, { 'estimate trade fee ok': (r) => r.status === 200 && r.json('status') === 'success' });
  sleep(SLEEP_SECONDS);

  // 14. Create idempotency key -- the frontend's own contracts file marks
  // this response shape as unconfirmed (no schema, treated as a bare
  // string); extract defensively in case it's wrapped in { key }.
  res = http.post(url('/orders/idempotent/key'), null, {
    headers: jsonHeaders(),
    tags: { name: 'CreateIdempotencyKey' },
  });
  const idempotencyOk = check(res, { 'create idempotency key ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
  if (!idempotencyOk) return;

  // Confirmed 2026-08-23: response is a raw, unquoted string (not valid
  // JSON) -- res.json() throws on it. Read res.body directly.
  const idempotencyKey = res.body && res.body.trim();
  if (!idempotencyKey) return;

  // 15. Place order -- confirmed exact FIX-coded payload shape (matches the
  // real order-ticket's buildPlaceOrderPayload()), plus accountId (not in
  // the documented type but required -- omitting it 400s with
  // INVALID_ACCOUNT). selfAccredited is null for unrestricted assets (true
  // only applies to Rule 4(a)(7)-restricted ones). Success is 201, not 200
  // -- same class of bug as sign()/refreshSession()/submit() elsewhere in
  // this suite -- and a 200/201 can still carry a REJECTED order, so also
  // assert status === 'success', not just the HTTP status.
  res = http.post(
    url('/orders'),
    JSON.stringify({
      accountId: secondaryAccountId,
      symbol,
      side: SIDE_TO_FIX[TRADE_SIDE],
      quantity: String(TRADE_QUANTITY),
      limitPrice: String(price),
      ordType: ORDER_TYPE_TO_FIX[TRADE_ORDER_TYPE],
      timeInForce: TIME_IN_FORCE_TO_FIX[TRADE_TIME_IN_FORCE],
      selfAccredited: null,
      idempotencyKey,
      assetId,
    }),
    { headers: jsonHeaders(), tags: { name: 'PlaceOrder' } }
  );
  const placeOk = check(res, { 'place order ok': (r) => (r.status === 200 || r.status === 201) && r.json('status') === 'success' });
  sleep(SLEEP_SECONDS);
  if (!placeOk) return;

  const orderId = res.json('orderId');
  if (!orderId) return;

  // 16. Cancel order -- the real app POSTs { orderId } as the body in
  // addition to the path param; harmless to include, matches production.
  res = http.post(url(`/orders/${orderId}/cancel`), JSON.stringify({ orderId }), {
    headers: jsonHeaders(),
    tags: { name: 'CancelOrder' },
  });
  check(res, { 'cancel order ok': (r) => r.status === 200 });
  sleep(SLEEP_SECONDS);
}

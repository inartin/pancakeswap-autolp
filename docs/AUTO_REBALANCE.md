# Auto-Rebalance

Optional intelligent auto-rebalancing system that manages positions based on market conditions.

## How It Works

**Core principle:** *Stay in range longer, don't chase price movements.*

The auto-rebalancer:

1. **Waits patiently** — Doesn't react immediately when price goes out of range (waits 10–30 minutes)
2. **Adapts to volatility** — Widens range in volatile markets, tightens in stable markets
3. **Avoids chop** — Detects sideways markets and extends wait times to prevent whipsaw
4. **Smart limits** — Flexible daily cap with intelligent exceptions for truly stuck positions

## Strategy Details

### Range modes (based on ATR)

- **TIGHT** (0.6%) — Calm market (ATR < 2%)
- **NORMAL** (1.5%) — Moderate volatility (ATR 2–5%)
- **WIDE** (3.0%) — High volatility (ATR > 5%)

### Range tightening

- If price stays stable for 1+ hour, range narrows automatically (0.6% → 0.4% → 0.2% → 0.1%)
- Maximizes fee earnings during stable periods

### Wait periods

- Base wait: 10–30 minutes depending on mode
- +5 minutes per "crossback" (price briefly going OOR then recovering)
- Choppy market (3+ crossbacks): wait extends to 30+ minutes and mode is forced to WIDE

### Safety rails

- Base limit: 20 rebalances per day per position
- **Smart exceptions** (always allow rebalance):
  - Position OOR for > 4 hours
  - More than 6 hours since last rebalance
  - Large position (> $500) OOR for > 2 hours
- Anti-churn: hard limit of 2 rebalances per hour
- Minimum position value: $50 USD
- Manual rebalances via `/rebalance` always work (bypass all limits)

---

## Enabling Auto-Rebalance

Auto-rebalance is controlled **individually per position** via the `/positions` menu.

**To enable:**

1. Open `/positions` in Telegram
2. Find the position you want to enable auto-rebalance for
3. Tap the `🤖❌ Auto-Rebalance` button
4. Review the explanation and tap `✅ Enable Auto-Rebalance`
5. Button updates to `🤖✅ Auto-Rebalance` (enabled)

**Default:** All positions have auto-rebalance disabled. You must explicitly enable it per position.

---

## What Happens When Enabled

Every 30 seconds, the bot:

1. Checks all active positions with auto-rebalance enabled
2. Evaluates market conditions (ATR, price stability, crossbacks)
3. Applies decision logic (wait periods, safety checks)
4. Auto-rebalances positions that meet criteria
5. Sends a notification when rebalancing starts

---

## Monitoring

### Console logs

```
🔍 Checking 2 active positions with auto-rebalance enabled...
⏭️  Position 123: Wait period not expired (8 minutes remaining)
✅ Position 456 ready for auto-rebalance: All conditions met
🤖 Auto-rebalance: Found 1 position(s) ready to rebalance
🔄 Auto-rebalancing position 456...
   Mode: NORMAL, Width: 1.5%
   Reason: Out of range for 15 minutes
✅ Auto-rebalance completed for position 456
```

### Telegram notifications

You will receive a message when:

- Auto-rebalance starts (shows mode, range, reason)
- Rebalance completes (detailed success message)
- An error occurs

---

## Cost Considerations

Auto-rebalancing costs ~$0.50–2.00 per rebalance in transaction fees (depending on network congestion).

The strategy minimizes costs by:

- Waiting patiently (10–30 min) before rebalancing
- Avoiding choppy markets (detects and delays)
- Skipping small positions (< $50)
- Daily limits prevent runaway costs

**Recommended for:**

- Positions > $500 (fees are < 0.4% of position value)
- Stable pairs (SOL/USDC, ETH/USDC) where strategy works best
- Users who want hands-off liquidity management

---

## Disabling

1. Open `/positions`
2. Tap `🤖✅ Auto-Rebalance` (enabled state)
3. Tap `❌ Disable Auto-Rebalance`

The button updates to `🤖❌ Auto-Rebalance` (disabled). Manual `/rebalance` always works regardless of this setting.

---

For implementation details, see [`AUTO_REBALANCE_IMPLEMENTATION.md`](AUTO_REBALANCE_IMPLEMENTATION.md).

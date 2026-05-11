# Auto-Rebalance Implementation Guide

## Overview

Intelligent automated position rebalancing system that adapts to market conditions and user needs.

**Status**: ✅ **COMPLETE** - Ready for testing

**Version**: 0.15.0 (with Adaptive Range Optimization)

---

## Core Strategy

### Principle
**Stay in range longer, not chase price movements.**

### Key Features
1. **Volatility-Adaptive**: Range width adjusts based on ATR (0.6% → 3%)
2. **Patient**: Waits 10-30 minutes before rebalancing
3. **Chop-Aware**: Detects sideways markets and extends wait times
4. **Smart Limits**: Flexible daily caps with intelligent exceptions

---

## Architecture

### Files Created
- `src/services/auto-rebalance.service.js` - Decision engine (400+ lines)

### Files Modified
- `src/config/constants.js` - Configuration constants + adaptive optimization config
- `src/services/scheduler.service.js` - Integration with monitoring loop
- `src/bot/handlers/rebalance.handler.js` - Auto-execution wrapper
- `src/services/market-data.service.js` - Active price history updates
- `src/bot/handlers/positions.handler.js` - Per-position toggle UI and handler
- `src/services/position.service.js` - Toggle functions for auto-rebalance
- `src/services/auto-rebalance.service.js` - Filter by per-position flag + adaptive optimization
- `src/bot/index.js` - Register callback handler
- `src/utils/apr.util.js` - Used for fee APR cost-benefit analysis

### Database
**Migration 0010** - Adds per-position auto-rebalance control:
- `positions.auto_rebalance_enabled` - Boolean flag (default: false)

**Uses existing statistics from v0.10.0**:
- `position_statistics.time_in_range_ms`
- `position_statistics.time_out_of_range_ms`
- `position_statistics.crossbacks_90m`
- `position_statistics.rebalances_today`
- `position_statistics.last_rebalance_at`

---

## Configuration

### Enable Feature

**Per-Position Control**: Auto-rebalance is controlled individually for each position.

To enable for a position:
1. Open `/positions` command
2. Click the `🤖❌ Auto-Rebalance` button next to the position
3. Review the explanation and click `✅ Enable Auto-Rebalance`

**Default State**: Auto-rebalance is **disabled** for all new positions. Users must explicitly enable it.

### Strategy Parameters

All tunable in `src/config/constants.js` → `AUTO_REBALANCE_CONFIG`:

**Range Modes**:
```javascript
TIGHT: {
  width: 0.6,        // 0.6% range
  atrThreshold: 2.0, // When ATR < 2%
  baseWaitMinutes: 10
}
NORMAL: {
  width: 1.5,        // 1.5% range
  atrThreshold: 5.0, // When ATR 2-5%
  baseWaitMinutes: 15
}
WIDE: {
  width: 3.0,        // 3% range
  atrThreshold: Infinity, // When ATR > 5%
  baseWaitMinutes: 20
}
```

**Range Tightening**:
```javascript
TIGHTENING: {
  enabled: true,
  intervalMinutes: 60,    // Check hourly
  stepSize: 0.2,          // Reduce 0.2% per step
  maxSteps: 3,            // Max 3 steps
  minimumWidth: 0.1       // Never below 0.1%
}
```

**Safety Rails**:
```javascript
SAFETY: {
  baseDailyLimit: 20,           // Soft limit
  hourlyChurnLimit: 2,          // Hard limit
  
  BYPASS_EXCEPTIONS: {
    extendedOorHours: 4,        // >4h OOR
    longGapHours: 6,            // >6h since last
    largePositionUsd: 500,      // >$500
    largePositionOorHours: 2    // Large pos >2h OOR
  },
  
  minPositionValueUsd: 50,      // Skip if <$50
  minWalletSol: 0.05           // Skip if <0.05 SOL
}
```

---

## Decision Flow

```
Every 30 seconds:
├─ Position in range?
│  └─ Continue monitoring
├─ Position out of range?
│  ├─ First time OOR? → Start wait timer
│  ├─ Still waiting?
│  │  ├─ Price recovered? → Cancel, mark back in range
│  │  └─ Wait expired?
│  │     ├─ Check daily limit (with exceptions)
│  │     ├─ Check hourly churn (hard limit)
│  │     ├─ Check position size (>$50)
│  │     ├─ Get market metrics (ATR)
│  │     ├─ Determine mode (TIGHT/NORMAL/WIDE)
│  │     ├─ Apply tightening (if stable)
│  │     ├─ Calculate center (TWAP_5m)
│  │     └─ Execute rebalance
```

---

## Functions Reference

### Decision Engine (`auto-rebalance.service.js`)

**Main Function**:
```javascript
shouldRebalance(positionId, isManual = false)
  → { allow: boolean, reason: string, data?: Object }
```
Returns decision with reasoning. If `allow: true`, includes rebalance parameters.

**Helper Functions**:
```javascript
determineRangeMode(atrPercent)
  → { mode: string, width: number, baseWaitMinutes: number }

calculateTightenedWidth(baseWidth, stats, atrPercent)
  → number  // Adjusted width

calculateWaitTime(mode, stats)
  → number  // Wait time in milliseconds

shouldBypassDailyLimit(stats, position)
  → { bypass: boolean, reason: string|null }

checkAllPositionsForRebalance()
  → Promise<Array<{ positionId, nftMint, poolAddress, decision }>>
```

### Execution (`rebalance.handler.js`)

```javascript
executeAutoRebalance(bot, positionId, nftMint, rebalanceData)
  → Promise<{ success: boolean, error?: string }>
```
Wraps existing `handleRebalance()` with auto-rebalance setup:
1. Updates position range_percent
2. Sends user notification
3. Calls manual rebalance handler
4. Returns success/error status

---

## Testing Checklist

### Unit Testing (Manual)

**Test 1: Per-Position Toggle**
```bash
# Start the bot
pnpm start

# In Telegram:
# 1. Open /positions
# 2. Click 🤖❌ Auto-Rebalance button (disabled by default)
# 3. Verify explanation message appears
# 4. Click ✅ Enable Auto-Rebalance
# 5. Verify button changes to 🤖✅ Auto-Rebalance
# 6. Check console: position should now be checked every 30s
```

**Test 2: Decision Logic**
```javascript
// In node REPL:
import { shouldRebalance } from './src/services/auto-rebalance.service.js';

// Test position (must have stats in DB)
const decision = await shouldRebalance(1, false);
console.log(decision);
// Should show: { allow: boolean, reason: string, ... }
```

**Test 3: Range Mode Selection**
```javascript
import { determineRangeMode } from './src/services/auto-rebalance.service.js';

determineRangeMode(1.5);  // TIGHT (ATR < 2%)
determineRangeMode(3.0);  // NORMAL (ATR 2-5%)
determineRangeMode(7.0);  // WIDE (ATR > 5%)
```

### Integration Testing (Live Bot)

**Test 1: Out-of-Range Detection**
1. Create test position with narrow range (0.3%)
2. Enable auto-rebalance for that position via `/positions` button
3. Wait for price to go OOR
4. Observe console logs:
   ```
   🔍 Checking 1 active positions with auto-rebalance enabled...
   ⏭️  Position X: Wait period not expired (Y minutes remaining)
   ```
5. Wait for wait period to expire
6. Should auto-rebalance with notification

**Test 2: Manual Override**
```bash
/rebalance <nft_mint>
```
- Should work even if daily limit reached
- Should bypass all wait periods

**Test 3: Daily Limit Exception**
1. Trigger 20 rebalances in one day (reach soft limit)
2. Let position go OOR for 4+ hours
3. Should bypass limit and rebalance (extended OOR exception)

**Test 4: Chop Detection**
1. Create position in choppy market
2. Price goes OOR and back 3+ times in 90 minutes
3. On next OOR, wait time should extend to 30+ minutes
4. Mode should force to WIDE

---

## Monitoring

### Console Output

**Normal Operation**:
```
📊 Updating price history: 2m gap
🔍 Checking 3 active positions for auto-rebalance...
⏭️  Position 123: Position is in range - no rebalance needed
⏭️  Position 456: Wait period not expired (8 minutes remaining)
```

**When Rebalancing**:
```
✅ Position 789 ready for auto-rebalance: All conditions met
🤖 Auto-rebalance: Found 1 position(s) ready to rebalance
🔄 Auto-rebalancing position 789 (ABC123...)...
   Mode: NORMAL, Width: 1.5%
   Reason: Out of range for 15 minutes
🤖 Auto-rebalance: Updated range to 1.5% for position ABC123...
✅ Auto-rebalance completed for position 789
```

**Exception Bypass**:
```
⚠️  Bypassing daily limit for position 456: Extended OOR (4.2h > 4h threshold)
```

### User Notifications

Users receive:
1. **Start notification**: Mode, range, reason
2. **Progress updates**: From rebalance handler (existing)
3. **Success message**: Transaction links, capital distribution (existing)

---

## Cost Analysis

### Per Rebalance
- Transaction fees: $0.50-2.00 (depends on network congestion)
- Rebalance cost: 0.1% of position value (hardcoded in handler)

### Monthly Estimate (Example Position)

**Position**: $1,000 SOL/USDC, ±1.5% range

**Scenario 1: Stable Market (ATR 1.5%)**
- Mode: TIGHT (0.6%)
- Rebalances: 2-3/month
- Cost: $5-10/month (0.5-1% of position)
- Benefit: Higher fee earnings (tighter range)

**Scenario 2: Volatile Market (ATR 6%)**
- Mode: WIDE (3%)
- Rebalances: 10-15/month
- Cost: $20-40/month (2-4% of position)
- Benefit: Stay in range, avoid IL

**Scenario 3: Choppy Market**
- Chop detection extends wait times
- Rebalances: 5-8/month
- Cost: $10-20/month (1-2% of position)

### Break-Even

For a $1,000 position earning 30% APR:
- Monthly earnings: ~$25
- Auto-rebalance cost: $10-40/month
- **Net positive if**: APR > 15-50% (most PCS pools qualify)

---

## Production Deployment

### Pre-Launch Checklist

- [ ] Test with small test position (<$100)
- [ ] Verify logs show decisions correctly
- [ ] Test manual override (`/rebalance`)
- [ ] Test daily limit exceptions
- [ ] Monitor for 24h with small positions
- [ ] Review statistics (rebalances_today, crossbacks_90m)

### Rollout Strategy

**Phase 1: Opt-In Beta** (Week 1-2)
- Document feature in README ✅
- Add to CHANGELOG ✅
- Share with trusted users
- Monitor closely

**Phase 2: General Availability** (Week 3+)
- Enable by default? (still requires ENV flag)
- Add `/autorebalance on|off` command
- Add configuration UI via Telegram

---

## Known Limitations

1. **SOL/USD Only**: ATR based on SOL price, not pool-specific
   - Works best for SOL-paired pools
   - Other pools use SOL volatility as proxy

2. **Hourly Tracking**: `rebalances_in_last_hour` uses heuristic
   - Accurate enough for anti-churn protection
   - Could be improved with dedicated tracking

3. **No Position-Specific Config**: Strategy applies to all positions
   - Future: Per-position mode override
   - Future: User-configurable thresholds

4. **Price History Dependency**: Requires Jupiter API uptime
   - Gracefully degrades (falls back to current price)
   - 30s cache prevents rate limiting

---

## Future Enhancements

### Short-Term (v0.15.0)
- [ ] `/autorebalance status` - Show current state for all positions
- [ ] Per-position mode override (TIGHT/NORMAL/WIDE)
- [ ] Hourly rebalance tracking in database

### Medium-Term (v0.16.0)
- [ ] Pool-specific volatility (use pool price history)
- [ ] User-configurable thresholds via Telegram
- [ ] A/B testing different strategies

### Long-Term (v1.0.0)
- [ ] Machine learning mode selection
- [ ] Backtest framework
- [ ] Multi-pool correlation analysis

---

## Troubleshooting

### Issue: Not Auto-Rebalancing

**Check**:
```bash
# 1. Feature enabled?
grep AUTO_REBALANCE_ENABLED .env
# Should show: AUTO_REBALANCE_ENABLED=true

# 2. Position statistics exist?
# Check DB: position_statistics table

# 3. Market data available?
# Console should show: "📊 Updating price history"

# 4. Wait period expired?
# Console shows remaining time
```

### Issue: Too Many Rebalances

**Check**:
```bash
# 1. Hourly churn limit working?
# Should stop at 5/hour

# 2. Crossback detection working?
# Check: crossbacks_90m in DB

# 3. Is market choppy?
# Check ATR in console logs
```

**Fix**: Manually increase wait times in constants:
```javascript
baseWaitMinutes: 20  // Instead of 10
```

### Issue: Not Enough Rebalances

**Check**:
```bash
# 1. Wait periods too long?
# Reduce in constants

# 2. Position too small?
# Check minPositionValueUsd

# 3. Daily limit hit?
# Check rebalances_today
```

---

## Support

**Documentation**:
- README.md - User guide
- CHANGELOG.md - Version history
- This file - Implementation details

**Code**:
- `src/services/auto-rebalance.service.js` - Core logic
- `src/services/scheduler.service.js` - Integration
- `src/config/constants.js` - Configuration

**Testing**:
- Create small test position
- Monitor console logs
- Review position statistics

---

## Conclusion

The auto-rebalance system is **production-ready** with:
- ✅ Comprehensive strategy implementation
- ✅ Multiple safety rails
- ✅ Extensive logging and monitoring
- ✅ User notifications
- ✅ Configuration flexibility
- ✅ No breaking changes

**Next Steps**:
1. Test with small positions
2. Monitor for 24-48 hours
3. Gather user feedback
4. Iterate on thresholds

---

**Last Updated**: 2025-11-10
**Version**: 0.14.0
**Status**: Ready for Testing ✅


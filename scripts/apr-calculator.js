/**
 * LP sim (monthly logs) — no double-counting.
 * Model:
 * - Gross rewards accrue daily from current LP: lp * apr / 365
 * - Split gross rewards: compound stays in LP, cashout leaves
 * - Slip/IL reduces LP daily: lp * (monthlySlip/30)
 *
 * Logs: month, lp_start, lp_end, compounded, cashout, slip_loss
 */
function simulateLp({
    aprPct,
    lpStart,
    dailyCompoundPct,
    monthlySlipPct,
    months = 6,
    daysPerMonth = 30,
  }) {
    const DAYS_PER_YEAR = 365;
  
    const apr = aprPct / 100;
    const compRate = dailyCompoundPct / 100;
    const slipDailyRate = (monthlySlipPct / 100) / daysPerMonth;
  
    let lp = lpStart;
  
    console.log(
      `APR=${aprPct}% | startLP=$${lpStart} | compound=${dailyCompoundPct}% | slip=${monthlySlipPct}%/mo | months=${months}`
    );
    console.log("m | lp_start | lp_end | comp_mo | cashout_mo | slip_mo");
  
    const r = (x) => Math.round(x);
  
    for (let m = 1; m <= months; m++) {
      const lpMonthStart = lp;
  
      let compAcc = 0;
      let cashAcc = 0;
      let slipAcc = 0;
  
      for (let d = 0; d < daysPerMonth; d++) {
        const gross = (lp * apr) / DAYS_PER_YEAR;
  
        const comp = gross * compRate;
        const cash = gross - comp;
  
        lp += comp;
        compAcc += comp;
        cashAcc += cash;
  
        const slip = lp * slipDailyRate;
        lp -= slip;
        slipAcc += slip;
      }
  
      console.log(
        `${m} | ${r(lpMonthStart)} | ${r(lp)} | ${r(compAcc)} | ${r(cashAcc)} | ${r(slipAcc)}`
      );
    }
  
    return lp;
  }
  
  // Your case:
  // simulateLp({ aprPct: 300, lpStart: 30000, dailyCompoundPct: 50, monthlySlipPct: 10, months: 6 });
  
/**
 * Doukou Observer Simulator - App Controller
 * JavaScript port of observer_simulator.py game flow + UI
 */

// ═══════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════

const INITIAL_PURSE = 50;
const MAX_ROUNDS = 100;
const PLAYERS = ['Boss', 'A', 'B', 'C'];
const STAKE_OPTIONS = [4, 8, 12, 16];

// ═══════════════════════════════════════════════════════
// Game State
// ═══════════════════════════════════════════════════════

const game = {
  // Config
  kellyMode: false,
  seed: 0,
  rng: null,

  // Session state
  obsPurse: INITIAL_PURSE,
  bossPurse: INITIAL_PURSE,
  roundNo: 0,
  phase: 'start', // start | betting | revealing | result | ended

  // Current round
  hands: null,
  currentBet: null, // { target, amount }

  // Stats
  stats: {
    skip: 0, bet: 0, win: 0, lose: 0, totalStaked: 0,
    betTargetCount: { A: 0, B: 0, C: 0 },
    stakeCount: {} // { amount: count }
  },

  // Session log
  log: [],

  // PnL history for chart
  pnlHistory: [0],

  exitReason: ''
};

// ═══════════════════════════════════════════════════════
// Kelly Stake
// ═══════════════════════════════════════════════════════

function kellyStake(purse, bossPurse) {
  const fraction = 0.20;
  let best = Math.floor(purse * fraction);

  if (best < 2 && purse >= 2) best = 2;
  if (best > bossPurse) best = bossPurse;
  if (best > purse) best = purse;
  if (best < 1) best = 0;

  return best;
}

// ═══════════════════════════════════════════════════════
// Settlement
// ═══════════════════════════════════════════════════════

function settle(hands, betTarget, betAmount) {
  const boss = hands[0];
  const targetIdxMap = { A: 1, B: 2, C: 3 };

  const employeeResults = {};
  for (const [label, idx] of Object.entries(targetIdxMap)) {
    const cmp = compareHands(boss, hands[idx]);
    employeeResults[label] = {
      won: cmp.winner === 'employee',
      mult: cmp.payoutMultiplier,
      reason: cmp.reason
    };
  }

  let observerPnl = 0;
  let bossPnl = 0;

  if (betTarget !== 'SKIP' && betAmount > 0) {
    const er = employeeResults[betTarget];
    if (er.won) {
      const gain = betAmount * er.mult;
      // Cap gain at boss purse
      observerPnl = Math.min(gain, game.bossPurse);
      bossPnl = -observerPnl;
    } else {
      observerPnl = -betAmount;
      bossPnl = betAmount;
    }
  }

  return { employeeResults, observerPnl, bossPnl };
}

// ═══════════════════════════════════════════════════════
// Game Flow
// ═══════════════════════════════════════════════════════

function startGame(kellyMode, seedStr) {
  game.kellyMode = kellyMode;
  game.seed = seedStr ? (parseInt(seedStr) || hashCode(seedStr)) : Math.floor(Date.now() / 1000);
  game.rng = mulberry32(game.seed);
  game.obsPurse = INITIAL_PURSE;
  game.bossPurse = INITIAL_PURSE;
  game.roundNo = 0;
  game.phase = 'betting';
  game.hands = null;
  game.currentBet = null;
  game.stats = {
    skip: 0, bet: 0, win: 0, lose: 0, totalStaked: 0,
    betTargetCount: { A: 0, B: 0, C: 0 },
    stakeCount: {}
  };
  game.log = [];
  game.pnlHistory = [0];
  game.exitReason = '';

  // Log session start
  pushLog({
    type: 'session_start',
    seed: game.seed,
    initialPurse: INITIAL_PURSE,
    maxRounds: MAX_ROUNDS,
    kellyMode: game.kellyMode
  });

  nextRound();
}

function nextRound() {
  game.roundNo++;
  if (game.roundNo > MAX_ROUNDS || game.obsPurse <= 0 || game.bossPurse <= 0) {
    endGame('normal');
    return;
  }

  game.hands = dealRound(game.rng);
  game.phase = 'betting';
  game.currentBet = null;

  renderGameScreen();
}

function placeBet(target, amount) {
  if (game.phase !== 'betting') return;

  if (target === 'SKIP') {
    game.currentBet = { target: 'SKIP', amount: 0 };
    game.stats.skip++;
  } else if (target === 'RUN') {
    game.roundNo--;
    game.exitReason = 'voluntary_run';
    pushLog({
      type: 'voluntary_run',
      beforeRound: game.roundNo + 1,
      observerPurse: game.obsPurse,
      bossPurse: game.bossPurse
    });
    endGame('voluntary_run');
    return;
  } else {
    // Validate amount
    if (amount > game.obsPurse) amount = game.obsPurse;
    if (amount > game.bossPurse) amount = game.bossPurse;
    if (amount < 1) return;

    game.currentBet = { target, amount };
    game.stats.bet++;
    game.stats.totalStaked += amount;
    game.stats.betTargetCount[target]++;
    game.stats.stakeCount[amount] = (game.stats.stakeCount[amount] || 0) + 1;
  }

  // Reveal
  game.phase = 'revealing';
  renderGameScreen();
  
  // Short delay then show result
  setTimeout(() => {
    const settlement = settle(game.hands, game.currentBet.target, game.currentBet.amount);
    const { observerPnl, bossPnl } = settlement;
  
    game.obsPurse += observerPnl;
    game.bossPurse += bossPnl;
  
    if (game.currentBet.target !== 'SKIP') {
      if (observerPnl > 0) game.stats.win++;
      else game.stats.lose++;
    }
  
    // Track PnL
    const cumPnl = game.pnlHistory[game.pnlHistory.length - 1] + observerPnl;
    game.pnlHistory.push(cumPnl);
  
    // Evaluate action
    const actionEval = evaluateAction(game.hands, game.currentBet.target, game.currentBet.amount);
  
    // Log round
    pushLog({
      type: 'round',
      round: game.roundNo,
      visible: PLAYERS.reduce((acc, p, i) => {
        acc[p] = [game.hands[i][0], game.hands[i][1]];
        return acc;
      }, {}),
      finalHands: PLAYERS.reduce((acc, p, i) => {
        acc[p] = game.hands[i];
        return acc;
      }, {}),
      finalStructures: PLAYERS.reduce((acc, p, i) => {
        acc[p] = explainHand(game.hands[i]);
        return acc;
      }, {}),
      employeeResults: settlement.employeeResults,
      betTarget: game.currentBet.target,
      betAmount: game.currentBet.amount,
      observerPnl,
      bossPnl,
      observerPurseAfter: game.obsPurse,
      bossPurseAfter: game.bossPurse,
      actionEval,
      // Extra fields for analysis
      empWinCount: ['A','B','C'].filter(l => settlement.employeeResults[l].won).length,
      empWith10pts: ['A','B','C'].filter(l => {
        const er = settlement.employeeResults[l];
        return er.won && er.mult >= 2;
      }).length
    });
  
    game.phase = 'result';
    renderGameScreen(settlement, actionEval);
  
    // Check termination
    if (game.obsPurse <= 0) {
      setTimeout(() => endGame('observer_broke'), 1500);
    } else if (game.bossPurse <= 0) {
      setTimeout(() => endGame('boss_broke'), 1500);
    }
  }, 300);
}

function endGame(reason) {
  game.phase = 'ended';
  if (!game.exitReason) game.exitReason = reason;

  pushLog({
    type: 'session_end',
    roundsPlayed: game.roundNo,
    observerFinal: game.obsPurse,
    bossFinal: game.bossPurse,
    exitReason: game.exitReason,
    stats: game.stats
  });

  saveLogToStorage();
  renderEndScreen();
}

// ═══════════════════════════════════════════════════════
// Logging
// ═══════════════════════════════════════════════════════

function pushLog(entry) {
  entry.timestamp = new Date().toISOString();
  game.log.push(entry);
}

function saveLogToStorage() {
  const key = `doukou_log_${game.seed}`;
  const jsonl = game.log.map(e => JSON.stringify(e)).join('\n');
  try {
    localStorage.setItem(key, jsonl);
  } catch (e) {
    // Storage full - ignore
  }
}

function downloadLog() {
  const jsonl = game.log.map(e => JSON.stringify(e)).join('\n');
  const blob = new Blob([jsonl], { type: 'application/jsonl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `observer_session_seed${game.seed}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function getVisible(hand) {
  return [hand[0], hand[1]];
}

/**
 * 5星战力分级（基于4人局50000局模拟 p_eq 数据）
 * tier: 5=5星, 4=4星, 3=3星, 2=2星, 1=1星
 * p_eq: 等效胜率（％），取自 50000局模拟数据
 * 口评0:
 *   5星: 1234(18 27 36 45 p_eq≈5353) | 12(12 23 p_eq≈50)
 *   4星: 127(13 24 78 p_eq≈49) | 235(25 38 58 p_eq≈48) | 631(68 34 14 p_eq≈48)
 *   3星: 234(26 35 48) | 876(89 79 67) | 554(57 56 47) | 1156(15 11 59 69) — p_eq 45–47
 *   2星: 4311(49 39 16 17) | 222(22 28 29) — p_eq 43–45
 *   1星: 3348(33 37 46 88) | 479(44 77 99) | 156(19 66 55) — p_eq <42
 */
const CORRECTED_TABLE = {
  // 5星（p_eq >= 50）
  '1,8': { tier: 5, p_eq: 54.32 },
  '3,6': { tier: 5, p_eq: 53.45 },
  '4,5': { tier: 5, p_eq: 53.34 },
  '2,7': { tier: 5, p_eq: 53.26 },
  '1,2': { tier: 5, p_eq: 50.98 },
  '2,3': { tier: 5, p_eq: 49.68 },  // 临界5星，归入12组
  // 4星（p_eq 47–49.6）
  '1,3': { tier: 4, p_eq: 49.06 },
  '2,4': { tier: 4, p_eq: 48.81 },
  '7,8': { tier: 4, p_eq: 48.66 },
  '3,8': { tier: 4, p_eq: 48.22 },
  '2,5': { tier: 4, p_eq: 47.99 },
  '5,8': { tier: 4, p_eq: 47.89 },
  '6,8': { tier: 4, p_eq: 47.86 },
  '3,4': { tier: 4, p_eq: 47.80 },
  '4,8': { tier: 4, p_eq: 47.31 },
  // 3星（p_eq 45–47.1）
  '1,4': { tier: 3, p_eq: 47.08 },
  '3,5': { tier: 3, p_eq: 47.07 },
  '2,6': { tier: 3, p_eq: 46.89 },
  '8,9': { tier: 3, p_eq: 46.86 },
  '6,7': { tier: 3, p_eq: 46.44 },
  '5,7': { tier: 3, p_eq: 45.78 },
  '7,9': { tier: 3, p_eq: 45.73 },
  '5,6': { tier: 3, p_eq: 45.61 },
  '4,7': { tier: 3, p_eq: 45.45 },
  '1,1': { tier: 3, p_eq: 45.37 },
  '1,5': { tier: 3, p_eq: 45.37 },
  '5,9': { tier: 3, p_eq: 45.07 },
  // 2星（p_eq 43–45）
  '6,9': { tier: 2, p_eq: 44.83 },
  '4,9': { tier: 2, p_eq: 44.52 },
  '3,9': { tier: 2, p_eq: 44.00 },
  '1,6': { tier: 2, p_eq: 43.85 },
  '1,7': { tier: 2, p_eq: 43.84 },
  '2,2': { tier: 2, p_eq: 43.77 },
  '2,9': { tier: 2, p_eq: 43.31 },
  // 1星（p_eq < 43）
  '2,8': { tier: 1, p_eq: 42.72 },
  '3,3': { tier: 1, p_eq: 41.44 },
  '3,7': { tier: 1, p_eq: 41.37 },
  '4,6': { tier: 1, p_eq: 41.35 },
  '8,8': { tier: 1, p_eq: 39.78 },
  '4,4': { tier: 1, p_eq: 38.54 },
  '7,7': { tier: 1, p_eq: 38.24 },
  '9,9': { tier: 1, p_eq: 37.50 },
  '1,9': { tier: 1, p_eq: 36.99 },
  '6,6': { tier: 1, p_eq: 36.20 },
  '5,5': { tier: 1, p_eq: 30.76 },
};

/**
 * Look up corrected tier info for a visible pair.
 * Returns { tier, winRate, correctedRate, avgMult, ev } or null.
 */
function lookupTier(a, b) {
  const key = [Math.min(a,b), Math.max(a,b)].join(',');
  return CORRECTED_TABLE[key] || null;
}

// ═══════════════════════════════════════════════════════
// Action Evaluation (出手规范分析)
// ═══════════════════════════════════════════════════════

// 星级标签文本
const TIER_LABEL = { 5: '5星', 4: '4星', 3: '3星', 2: '2星', 1: '1星' };

// 推荐注码：2档差┩4, 3档差┩8, 4档差┩12, 4档差特殊┩16
const STAKE_FOR_GAP = { 2: 4, 3: 8, 4: 12 };

function tierLabel(t) { return TIER_LABEL[t] || `${t}星`; }

function getPlayerPower(hand) {
  const v = [hand[0], hand[1]];
  return lookupTier(v[0], v[1]);
}

function evaluateAction(hands, betTarget, betAmount) {
  const bossInfo = getPlayerPower(hands[0]);
  const empInfos = {
    A: getPlayerPower(hands[1]),
    B: getPlayerPower(hands[2]),
    C: getPlayerPower(hands[3])
  };

  const bossTier = bossInfo ? bossInfo.tier : 3;
  const bossRate = bossInfo ? bossInfo.p_eq : 45;

  // 计算每个员工vs老板的战力差
  const gaps = {};
  for (const lbl of ['A', 'B', 'C']) {
    const info = empInfos[lbl];
    if (info) {
      gaps[lbl] = {
        rateDiff: info.p_eq - bossRate,
        tierDiff: info.tier - bossTier,
        tier: info.tier,
        rate: info.p_eq
      };
    } else {
      gaps[lbl] = { rateDiff: 0, tierDiff: 0, tier: 3, rate: 45 };
    }
  }

  // 找最佳员工（最高等效胜率）
  let bestLbl = null;
  let bestGap = -999;
  for (const lbl of ['A', 'B', 'C']) {
    const g = gaps[lbl].rateDiff;
    if (g > bestGap) { bestGap = g; bestLbl = lbl; }
  }

  // 如果下注，用选中员工；如果 SKIP，用最佳员工作参考
  const evalLbl = (betTarget === 'SKIP') ? (bestLbl || 'A') : betTarget;
  const sel = gaps[evalLbl];

  // 构建显示字符串: "X星-Y星=Z档；M%-N%=±D%；投N或pass"
  function buildDetail(empTier, empRate, bossTierV, bossRateV, gapDiff, rateDiff, stakeStr) {
    const gap = gapDiff >= 0 ? gapDiff : 0;
    const rateD = (rateDiff >= 0 ? '+' : '') + rateDiff.toFixed(0) + '%';
    // 格式: "5-2=3星；50%-40%=+10%；挂5或pass"
    return `${empTier}-${bossTierV}=${gap}星；${empRate.toFixed(0)}%-${bossRateV.toFixed(0)}%=${rateD}；${stakeStr}`;
  }

  // ——— SKIP ———
  if (betTarget === 'SKIP') {
    // 以最佳员工作为参考评估
    const stakeStr = 'pass';
    const d = buildDetail(sel.tier, sel.rate, bossTier, bossRate, sel.tierDiff, sel.rateDiff, stakeStr);
    // 等级差 < 2：pass 理性；等级差 >= 2：pass 保守（放弃了好机会）
    const tag = sel.tierDiff >= 2 ? '保守' : '理性';
    return { tag, detail: d };
  }

  // ——— 下注 ———
  // 推荐注码：gap=2→4, gap=3→8, gap=4→12, gap>=5→16, gap<=1→4
  const recStake = STAKE_FOR_GAP[sel.tierDiff] || (sel.tierDiff >= 4 ? 12 : 4);
  const stakeStr = `投${betAmount}`;
  const d = buildDetail(sel.tier, sel.rate, bossTier, bossRate, sel.tierDiff, sel.rateDiff, stakeStr);

  // 冒进：战力不占优（tier差<=0）还投注
  if (sel.tierDiff <= 0) {
    return { tag: '冒进', detail: d };
  }

  // 注码与战力差的匹配判断
  if (betAmount > recStake) {
    // 小差投大注 → 冒进
    return { tag: '冒进', detail: d };
  }
  if (betAmount < recStake) {
    // 大差投小注 → 保守
    return { tag: '保守', detail: d };
  }

  // 投注匹配战力差 → 理性
  return { tag: '理性', detail: d };
}

function getActionStats() {
  const roundLogs = game.log.filter(e => e.type === 'round');
  const stats = {
    理性: { count: 0, win: 0, betCount: 0, betWin: 0, passCount: 0, passWin: 0 },
    冒进: { count: 0, win: 0, betCount: 0, betWin: 0, passCount: 0, passWin: 0 },
    保守: { count: 0, win: 0, betCount: 0, betWin: 0, passCount: 0, passWin: 0 }
  };

  for (const r of roundLogs) {
    if (!r.actionEval) { console.warn('[actionStats] no actionEval', r); continue; }
    const tag = r.actionEval.tag;
    if (!stats[tag]) { console.warn('[actionStats] unknown tag', tag); continue; }
    stats[tag].count++;
    const isSkip = r.betTarget === 'SKIP';
    console.log(`[actionStats] round=${r.round} tag=${tag} betTarget=${JSON.stringify(r.betTarget)} isSkip=${isSkip} empWinCount=${r.empWinCount} observerPnl=${r.observerPnl}`);
    if (isSkip) {
      stats[tag].passCount++;
      const empWins = r.empWinCount || 0;
      if (empWins <= 1) {
        stats[tag].passWin++;
        stats[tag].win++;
      }
    } else {
      stats[tag].betCount++;
      if (r.observerPnl > 0) {
        stats[tag].betWin++;
        stats[tag].win++;
      }
    }
  }

  return stats;
}

// ═══════════════════════════════════════════════════════
// Session Analysis
// ═══════════════════════════════════════════════════════

function analyzeSession() {
  const roundLogs = game.log.filter(e => e.type === 'round');
  if (roundLogs.length === 0) return null;

  const betRounds = roundLogs.filter(e => e.betTarget !== 'SKIP');
  const skipRounds = roundLogs.filter(e => e.betTarget === 'SKIP');

  // --- Bet win rates ---
  const betWins = betRounds.filter(e => e.observerPnl > 0).length;
  const betWinRate = betRounds.length > 0 ? (betWins / betRounds.length * 100) : 0;

  // --- Win rate by stake amount ---
  const byStake = {};
  for (const r of betRounds) {
    const s = r.betAmount;
    if (!byStake[s]) byStake[s] = { total: 0, wins: 0 };
    byStake[s].total++;
    if (r.observerPnl > 0) byStake[s].wins++;
  }

  // --- Pass rate ---
  const passRate = roundLogs.length > 0 ? (skipRounds.length / roundLogs.length * 100) : 0;

  // --- When PASS: Boss dominance analysis ---
  let passBossAllWin = 0;    // 0 employees won
  let pass1EmpWin = 0;       // 1 employee won
  let pass2EmpWin = 0;       // 2 employees won
  let pass3EmpWin = 0;       // 3 employees won (boss lost all)
  let passEmp10pts = 0;      // employees with >=2x payout (10pts or special)

  for (const r of skipRounds) {
    const ewc = r.empWinCount;
    if (ewc === 0) passBossAllWin++;
    else if (ewc === 1) pass1EmpWin++;
    else if (ewc === 2) pass2EmpWin++;
    else if (ewc === 3) pass3EmpWin++;

    passEmp10pts += (r.empWith10pts || 0);
  }

  // --- Employee overall win rate (ALL rounds, not just when I bet them) ---
  const empOverall = { A: { total: 0, wins: 0 }, B: { total: 0, wins: 0 }, C: { total: 0, wins: 0 } };
  for (const r of roundLogs) {
    for (const lbl of ['A', 'B', 'C']) {
      const er = r.employeeResults[lbl];
      if (er) {
        empOverall[lbl].total++;
        if (er.won) empOverall[lbl].wins++;
      }
    }
  }

  return {
    totalRounds: roundLogs.length,
    betRounds: betRounds.length,
    betWins,
    skipRounds: skipRounds.length,
    betWinRate,
    byStake,
    passRate,
    passBossAllWin,
    pass1EmpWin,
    pass2EmpWin,
    pass3EmpWin,
    passEmp10pts,
    empOverall,
    netPnl: game.obsPurse - INITIAL_PURSE
  };
}

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
const STAKE_OPTIONS = [2, 4, 8];

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
 * Corrected tier lookup from 斗口起手卡力修正概率表
 * Key: sorted pair "a,b" → { tier, winRate, correctedRate, avgMult, ev }
 */
const CORRECTED_TABLE = {
  '1,1': { tier: 'A', winRate: 39.12, correctedRate: 45.69, avgMult: 1.335, ev: -0.0862 },
  '1,2': { tier: 'S+', winRate: 47.02, correctedRate: 53.11, avgMult: 1.259, ev: 0.0622 },
  '1,3': { tier: 'S+', winRate: 44.20, correctedRate: 49.65, avgMult: 1.247, ev: -0.0070 },
  '1,4': { tier: 'S', winRate: 43.23, correctedRate: 48.34, avgMult: 1.237, ev: -0.0333 },
  '1,5': { tier: 'A', winRate: 42.15, correctedRate: 46.58, avgMult: 1.210, ev: -0.0685 },
  '1,6': { tier: 'A', winRate: 40.60, correctedRate: 44.16, avgMult: 1.175, ev: -0.1168 },
  '1,7': { tier: 'B', winRate: 39.90, correctedRate: 43.06, avgMult: 1.159, ev: -0.1388 },
  '1,8': { tier: 'S+', winRate: 50.45, correctedRate: 54.90, avgMult: 1.176, ev: 0.0980 },
  '1,9': { tier: 'C', winRate: 32.57, correctedRate: 37.19, avgMult: 1.283, ev: -0.2562 },
  '2,2': { tier: 'B', winRate: 38.00, correctedRate: 42.66, avgMult: 1.245, ev: -0.1467 },
  '2,3': { tier: 'S', winRate: 44.57, correctedRate: 49.25, avgMult: 1.210, ev: -0.0150 },
  '2,4': { tier: 'S', winRate: 43.90, correctedRate: 48.79, avgMult: 1.223, ev: -0.0243 },
  '2,5': { tier: 'S', winRate: 44.42, correctedRate: 48.43, avgMult: 1.180, ev: -0.0315 },
  '2,6': { tier: 'A', winRate: 43.18, correctedRate: 46.61, avgMult: 1.159, ev: -0.0678 },
  '2,7': { tier: 'S+', winRate: 49.68, correctedRate: 53.96, avgMult: 1.173, ev: 0.0793 },
  '2,8': { tier: 'B', winRate: 38.35, correctedRate: 42.74, avgMult: 1.229, ev: -0.1452 },
  '2,9': { tier: 'B', winRate: 38.32, correctedRate: 42.08, avgMult: 1.196, ev: -0.1585 },
  '3,3': { tier: 'B', winRate: 38.40, correctedRate: 42.50, avgMult: 1.214, ev: -0.1500 },
  '3,4': { tier: 'A', winRate: 42.73, correctedRate: 46.69, avgMult: 1.185, ev: -0.0663 },
  '3,5': { tier: 'A', winRate: 43.08, correctedRate: 46.44, avgMult: 1.156, ev: -0.0712 },
  '3,6': { tier: 'S+', winRate: 48.95, correctedRate: 53.10, avgMult: 1.170, ev: 0.0620 },
  '3,7': { tier: 'C', winRate: 36.83, correctedRate: 41.30, avgMult: 1.243, ev: -0.1740 },
  '3,8': { tier: 'S', winRate: 44.77, correctedRate: 48.46, avgMult: 1.165, ev: -0.0307 },
  '3,9': { tier: 'A', winRate: 40.67, correctedRate: 44.62, avgMult: 1.194, ev: -0.1075 },
  '4,4': { tier: 'C', winRate: 36.40, correctedRate: 39.52, avgMult: 1.172, ev: -0.2095 },
  '4,5': { tier: 'S+', winRate: 51.00, correctedRate: 55.24, avgMult: 1.166, ev: 0.1047 },
  '4,6': { tier: 'C', winRate: 36.58, correctedRate: 41.00, avgMult: 1.242, ev: -0.1800 },
  '4,7': { tier: 'A', winRate: 42.50, correctedRate: 46.23, avgMult: 1.175, ev: -0.0755 },
  '4,8': { tier: 'S', winRate: 44.30, correctedRate: 47.98, avgMult: 1.166, ev: -0.0405 },
  '4,9': { tier: 'B', winRate: 40.05, correctedRate: 43.84, avgMult: 1.189, ev: -0.1232 },
  '5,5': { tier: 'C', winRate: 24.73, correctedRate: 28.95, avgMult: 1.342, ev: -0.4210 },
  '5,6': { tier: 'A', winRate: 41.83, correctedRate: 44.77, avgMult: 1.141, ev: -0.1045 },
  '5,7': { tier: 'A', winRate: 42.93, correctedRate: 46.65, avgMult: 1.174, ev: -0.0670 },
  '5,8': { tier: 'S', winRate: 44.38, correctedRate: 48.35, avgMult: 1.179, ev: -0.0330 },
  '5,9': { tier: 'A', winRate: 41.42, correctedRate: 45.20, avgMult: 1.182, ev: -0.0960 },
  '6,6': { tier: 'C', winRate: 34.20, correctedRate: 37.11, avgMult: 1.170, ev: -0.2577 },
  '6,7': { tier: 'A', winRate: 42.85, correctedRate: 46.15, avgMult: 1.154, ev: -0.0770 },
  '6,8': { tier: 'A', winRate: 42.90, correctedRate: 46.39, avgMult: 1.163, ev: -0.0722 },
  '6,9': { tier: 'A', winRate: 42.00, correctedRate: 46.05, avgMult: 1.193, ev: -0.0790 },
  '7,7': { tier: 'C', winRate: 35.33, correctedRate: 38.24, avgMult: 1.165, ev: -0.2352 },
  '7,8': { tier: 'S', winRate: 43.88, correctedRate: 47.61, avgMult: 1.170, ev: -0.0478 },
  '7,9': { tier: 'S', winRate: 43.50, correctedRate: 47.80, avgMult: 1.198, ev: -0.0440 },
  '8,8': { tier: 'C', winRate: 37.97, correctedRate: 41.08, avgMult: 1.163, ev: -0.1785 },
  '8,9': { tier: 'S', winRate: 43.30, correctedRate: 47.44, avgMult: 1.191, ev: -0.0512 },
  '9,9': { tier: 'C', winRate: 34.62, correctedRate: 37.98, avgMult: 1.194, ev: -0.2405 },
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

const TIER_VALUE = { 'S+': 5, 'S': 4, 'A': 3, 'B': 2, 'C': 1 };

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

  const bossRate = bossInfo ? bossInfo.correctedRate : 40;
  const bossTierVal = bossInfo ? (TIER_VALUE[bossInfo.tier] || 3) : 3;

  // 计算每个员工vs老板的战力差
  const gaps = {};
  for (const lbl of ['A', 'B', 'C']) {
    const info = empInfos[lbl];
    if (info) {
      gaps[lbl] = {
        rateDiff: info.correctedRate - bossRate,
        tierDiff: (TIER_VALUE[info.tier] || 3) - bossTierVal,
        tier: info.tier,
        rate: info.correctedRate
      };
    } else {
      gaps[lbl] = { rateDiff: 0, tierDiff: 0, tier: '-', rate: 0 };
    }
  }

  // 找最佳员工
  let bestLbl = null;
  let bestGap = -999;
  for (const lbl of ['A', 'B', 'C']) {
    const g = gaps[lbl].rateDiff;
    if (g > bestGap) { bestGap = g; bestLbl = lbl; }
  }

  // 判断是否存在"明显机会"
  const hasClearOpportunity = ['A','B','C'].some(lbl => {
    const g = gaps[lbl];
    return g.rateDiff >= 5 && g.tierDiff >= 1;
  });

  // 判断是否存在"明显优势机会"
  const hasStrongOpportunity = ['A','B','C'].some(lbl => {
    const g = gaps[lbl];
    return g.rateDiff >= 8 || g.tierDiff >= 2;
  });

  // 老板是否是明显弱势
  const bossIsWeak = bossInfo && (bossInfo.tier === 'C' || bossInfo.correctedRate <= 37);

  // ─── 用户选择SKIP ───
  if (betTarget === 'SKIP') {
    if (hasClearOpportunity || bossIsWeak) {
      return { tag: '保守', reason: '明显优势机会却选择观望' };
    }
    return { tag: '理性', reason: '无明显战力优势，跳过合理' };
  }

  // ─── 用户下注 ───
  const sel = gaps[betTarget];

  // 冒进：选中员工没有明显优势
  if (sel.rateDiff < 3 || sel.tierDiff <= 0) {
    if (betAmount >= 8) {
      return { tag: '冒进', reason: '战力不占优却重注出击' };
    }
    return { tag: '冒进', reason: '选中员工战力不优于老板' };
  }

  // 冒进：明明有更好选择却选了弱的
  if (bestLbl && bestLbl !== betTarget && gaps[bestLbl].rateDiff - sel.rateDiff >= 5) {
    return { tag: '冒进', reason: '有更强员工未选，选择欠妥' };
  }

  // 保守：明显优势却出手太轻
  if (hasStrongOpportunity && betAmount <= 4) {
    return { tag: '保守', reason: '明显优势下出手太轻' };
  }

  // 保守：选了正确员工但注码偏小
  if (sel.rateDiff >= 8 && betAmount <= 4) {
    return { tag: '保守', reason: '战力差显著，该重注' };
  }

  // 理性
  if (sel.rateDiff >= 5 && sel.tierDiff >= 1) {
    return { tag: '理性', reason: '战力差明显，出手合理' };
  }
  if (bossIsWeak && sel.rateDiff >= 0) {
    return { tag: '理性', reason: '老板弱势，出击合理' };
  }
  return { tag: '理性', reason: '出手符合规范' };
}

function getActionStats() {
  const roundLogs = game.log.filter(e => e.type === 'round');
  const stats = {
    理性: { count: 0, win: 0, betCount: 0, betWin: 0, passCount: 0, passWin: 0 },
    冒进: { count: 0, win: 0, betCount: 0, betWin: 0, passCount: 0, passWin: 0 },
    保守: { count: 0, win: 0, betCount: 0, betWin: 0, passCount: 0, passWin: 0 }
  };

  for (const r of roundLogs) {
    if (!r.actionEval) continue;
    const tag = r.actionEval.tag;
    if (!stats[tag]) continue;
    stats[tag].count++;
    if (r.betTarget === 'SKIP') {
      // PASS局：老板赢得多（员工赢<=1方）= 准确
      stats[tag].passCount++;
      const empWins = r.empWinCount || 0;
      if (empWins <= 1) {
        stats[tag].passWin++;
        stats[tag].win++;
      }
    } else {
      // 出手局：自己赢 = 准确
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

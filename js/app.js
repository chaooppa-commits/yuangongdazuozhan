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
const STAKE_OPTIONS = [4, 8, 12, 16, 20];

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

function startGame(kellyMode, seedStr, buyin) {
  const initialPurse = buyin || INITIAL_PURSE;
  game.kellyMode = kellyMode;
  game.seed = seedStr ? (parseInt(seedStr) || hashCode(seedStr)) : Math.floor(Date.now() / 1000);
  game.rng = mulberry32(game.seed);
  game.obsPurse = initialPurse;
  game.bossPurse = initialPurse;
  game._initialPurse = initialPurse; // 记录本场带入金额
  game.roundNo = 0;
  game.phase = 'betting';
  game.hands = null;
  game.currentBet = null;
  game.stats = {
    skip: 0, bet: 0, win: 0, lose: 0, totalStaked: 0,
    betTargetCount: { A: 0, B: 0, C: 0 },
    stakeCount: {},
    flatEat: { obs: 0, A: 0, B: 0, C: 0 },
    multCount: { 2: 0, 3: 0, 4: 0 }
  };
  game.log = [];
  game.pnlHistory = [0];
  game.exitReason = '';
  game.obsMaxPurse = initialPurse;
  game.obsMinPurse = initialPurse;

  // Log session start
  pushLog({
    type: 'session_start',
    seed: game.seed,
    initialPurse: initialPurse,
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
  
    // 追踪观察者最高/最低筹码
    if (game.obsPurse > game.obsMaxPurse) game.obsMaxPurse = game.obsPurse;
    if (game.obsPurse < game.obsMinPurse) game.obsMinPurse = game.obsPurse;
  
    if (game.currentBet.target !== 'SKIP') {
      if (observerPnl > 0) {
        game.stats.win++;
        // 统计多倍赔率
        const er = settlement.employeeResults[game.currentBet.target];
        if (er && er.mult >= 2) game.stats.multCount[er.mult]++;
      } else {
        game.stats.lose++;
      }
    }
  
    // 统计平吃：庄家平吃各玩家（分数相同或双方无斗口）
    for (const lbl of ['A', 'B', 'C']) {
      const er = settlement.employeeResults[lbl];
      if (!er.won && er.reason &&
          (er.reason.includes('点数相同') || er.reason === '双方无斗口')) {
        game.stats.flatEat[lbl]++;
        // 如果观察者押注了这个玩家，也计入 obs
        if (game.currentBet.target === lbl) {
          game.stats.flatEat.obs++;
        }
      }
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
    stats: game.stats,
    shadow: typeof shadow !== 'undefined' ? {
      finalPurse: shadow.purse,
      netPnl: shadow.purse - (typeof INITIAL_PURSE !== 'undefined' ? INITIAL_PURSE : 50),
      rounds: shadow.bet + shadow.skip,
      bet: shadow.bet,
      skip: shadow.skip,
      win: shadow.win,
      lose: shadow.lose,
      totalStaked: shadow.totalStaked,
      winRate: shadow.bet > 0 ? +(shadow.win / shadow.bet * 100).toFixed(1) : 0,
      roi: shadow.totalStaked > 0
        ? +((shadow.purse - (typeof INITIAL_PURSE !== 'undefined' ? INITIAL_PURSE : 50)) / shadow.totalStaked * 100).toFixed(1)
        : 0,
      exited: shadow.exited
    } : null
  });

  saveLogToStorage();
  reportToSheets();
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
// Google Sheets 数据上报
// ═══════════════════════════════════════════════════════

const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbyxk9cNDaL86XQ53f70ANC1vwxO3Cael2LWiUW6ipjJXk3PyS2uYMn2cTNXQi8VzE6eqg/exec';

function reportToSheets() {
  try {
    const buyin = game._initialPurse || INITIAL_PURSE;
    const username = game._username || '匿名';
    const netPnl = game.obsPurse - buyin;
    const totalBet = game.stats.bet;
    const roi = game.stats.totalStaked > 0
      ? +(netPnl / game.stats.totalStaked * 100).toFixed(1) : 0;

    // localStorage 里累计历史数据
    const histKey = `doukou_hist_${username}`;
    let hist = JSON.parse(localStorage.getItem(histKey) || '{}');
    hist.totalSessions  = (hist.totalSessions  || 0);
    hist.winSessions    = (hist.winSessions    || 0);
    hist.totalRounds    = (hist.totalRounds    || 0);
    hist.totalBetRounds = (hist.totalBetRounds || 0);
    hist.totalWins      = (hist.totalWins      || 0);

    hist.totalSessions += 1;
    if (netPnl > 0) hist.winSessions += 1;
    hist.totalRounds    += game.roundNo;
    hist.totalBetRounds += game.stats.bet;
    hist.totalWins      += game.stats.win;
    localStorage.setItem(histKey, JSON.stringify(hist));

    const sessionWinRate = hist.totalSessions > 0
      ? +(hist.winSessions / hist.totalSessions * 100).toFixed(1) : 0;
    const totalWinRate = hist.totalBetRounds > 0
      ? +(hist.totalWins / hist.totalBetRounds * 100).toFixed(1) : 0;

    // 荷包结算：开场前荷包 - 带入 + 本场余额
    const walletBefore = game._walletBefore || buyin;
    const newWallet = walletBefore - buyin + game.obsPurse;

    const exitMap = {
      'normal': '正常结束',
      'observer_broke': '荷包打空',
      'boss_broke': '老板打空',
      'voluntary_run': '主动离场',
      'interrupted': '中断'
    };

    const payload = {
      action: 'endSession',
      timestamp: new Date().toISOString(),
      username,
      pincode: game._pincode || '',
      buyin,
      newWallet,         // 本场结算后的新荷包余额
      // 历史场次统计
      totalSessions: hist.totalSessions,
      winSessions: hist.winSessions,
      sessionWinRate,
      // 累计局次统计
      totalRounds: hist.totalRounds,
      totalBetRounds: hist.totalBetRounds,
      totalWins: hist.totalWins,
      totalWinRate,
      // 本场资金结果
      finalPurse: game.obsPurse,
      netPnl,
      roi,
      // 元数据
      sessionResult: netPnl > 0 ? '赢场' : netPnl < 0 ? '输场' : '平场',
      exitReason: exitMap[game.exitReason] || game.exitReason,
      seed: game.seed
    };

    // GET 请求，Apps Script doGet 天然支持跨域，直接发送即可
    const params = Object.keys(payload).map(k =>
      encodeURIComponent(k) + '=' + encodeURIComponent(payload[k])
    ).join('&');
    fetch(SHEETS_URL + '?' + params)
      .then(r => r.json())
      .then(d => console.log('上报成功:', d))
      .catch(err => console.warn('上报失败:', err));

  } catch (err) {
    console.warn('上报错误:', err);
  }
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
  '1,8': { tier: 5, p_eq: 54.32, mn: '1234', mp: 54 },
  '3,6': { tier: 5, p_eq: 53.45, mn: '1234', mp: 53 },
  '4,5': { tier: 5, p_eq: 53.34, mn: '1234', mp: 53 },
  '2,7': { tier: 5, p_eq: 53.26, mn: '1234', mp: 53 },
  '1,2': { tier: 5, p_eq: 50.98, mn: '12',   mp: 51 },
  '2,3': { tier: 5, p_eq: 49.68, mn: '12',   mp: 50 },
  // 4星（p_eq 47–49.6）
  '1,3': { tier: 4, p_eq: 49.06, mn: '127', mp: 49 },
  '2,4': { tier: 4, p_eq: 48.81, mn: '127', mp: 49 },
  '7,8': { tier: 4, p_eq: 48.66, mn: '127', mp: 49 },
  '3,8': { tier: 4, p_eq: 48.22, mn: '235', mp: 48 },
  '2,5': { tier: 4, p_eq: 47.99, mn: '235', mp: 48 },
  '5,8': { tier: 4, p_eq: 47.89, mn: '235', mp: 48 },
  '6,8': { tier: 4, p_eq: 47.86, mn: '631', mp: 48 },
  '3,4': { tier: 4, p_eq: 47.80, mn: '631', mp: 48 },
 

  // 3星（p_eq 45–47.1）
  '1,4': { tier: 4., p_eq: 47.08, mn: '1234', mp: 47 },
  '4,8': { tier: 3., p_eq: 47.31, mn: '1234', mp: 47 },
  '3,5': { tier: 3, p_eq: 47.07, mn: '1234', mp: 47 },
  '2,6': { tier: 3, p_eq: 46.89, mn: '1234', mp: 47 },
  '8,9': { tier: 3, p_eq: 46.86, mn: '876', mp: 46 },
  '7,9': { tier: 3, p_eq: 45.73, mn: '876', mp: 46 },
  '6,7': { tier: 3, p_eq: 46.44, mn: '876', mp: 46 },
  '5,7': { tier: 3, p_eq: 45.78, mn: '554', mp: 46 },
  '5,6': { tier: 3, p_eq: 45.61, mn: '554', mp: 46 },
  '4,7': { tier: 3, p_eq: 45.45, mn: '554', mp: 46 },
  '1,1': { tier: 3, p_eq: 45.37, mn: '1156', mp: 45 },
  '1,5': { tier: 3, p_eq: 45.37, mn: '1156', mp: 45 },
  '5,9': { tier: 3, p_eq: 45.07, mn: '1156', mp: 45 },
  '6,9': { tier: 3., p_eq: 44.83, mn: '1156', mp: 44 },
  // 2星（p_eq 43–45）
  '4,9': { tier: 2, p_eq: 44.52, mn: '4311', mp: 44 },
  '3,9': { tier: 2, p_eq: 44.00, mn: '4311', mp: 44 },
  '1,6': { tier: 2, p_eq: 43.85, mn: '4311', mp: 44 },
  '1,7': { tier: 2, p_eq: 43.84, mn: '4311', mp: 44 },
  '2,2': { tier: 2, p_eq: 43.77, mn: '222', mp: 43 },
  '2,9': { tier: 2, p_eq: 43.31, mn: '222', mp: 43 },
  '2,8': { tier: 2., p_eq: 42.72, mn: '222', mp: 41 },  
  // 1星（p_eq < 43）
  '3,3': { tier: 1, p_eq: 41.44, mn: '3348', mp: 41 },
  '3,7': { tier: 1, p_eq: 41.37, mn: '3348', mp: 41 },
  '4,6': { tier: 1, p_eq: 41.35, mn: '3348', mp: 41 },
  '8,8': { tier: 1, p_eq: 39.78, mn: '3348', mp: 40 },
  '4,4': { tier: 1, p_eq: 38.54, mn: '479', mp: 38 },
  '7,7': { tier: 1, p_eq: 38.24, mn: '479', mp: 38 },
  '9,9': { tier: 1, p_eq: 37.50, mn: '479', mp: 38 },
  '1,9': { tier: 1, p_eq: 36.99, mn: '156', mp: 36 },
  '6,6': { tier: 1, p_eq: 36.20, mn: '156', mp: 36 },
  '5,5': { tier: 1, p_eq: 30.76, mn: '156', mp: 30 },
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
  const bossRate = bossInfo ? bossInfo.p_eq : 45;
  const bossMp = bossInfo ? bossInfo.mp : 40;
  const bossTier = bossInfo ? bossInfo.tier : 3;

  const empInfos = {
    A: getPlayerPower(hands[1]),
    B: getPlayerPower(hands[2]),
    C: getPlayerPower(hands[3])
  };

  // 计算每个员工vs老板的战力差
  const gaps = {};
  for (const lbl of ['A', 'B', 'C']) {
    const info = empInfos[lbl];
    if (info) {
      gaps[lbl] = {
        rateDiff: info.p_eq - bossRate,
        mpDiff: info.mp - bossMp,
        tierDiff: info.tier - bossTier,
        tier: info.tier,
        rate: info.p_eq,
        mp: info.mp
      };
    } else {
      gaps[lbl] = { rateDiff: 0, mpDiff: 0, tierDiff: 0, tier: 3, rate: 45, mp: 40 };
    }
  }

  // 找最佳员工（最高等效胜率）
  let bestLbl = null;
  let bestGap = -999;
  for (const lbl of ['A', 'B', 'C']) {
    const g = gaps[lbl].rateDiff;
    if (g > bestGap) { bestGap = g; bestLbl = lbl; }
  }

  // 构建显示字符串
  function buildDetail(empTier, empRate, bossTierV, bossRateV, gapDiff, rateDiff, stakeStr) {
    const gap = gapDiff >= 0 ? gapDiff : 0;
    const rateD = (rateDiff >= 0 ? '+' : '') + rateDiff.toFixed(0) + '%';
    return `${empTier}-${bossTierV}=${gap}星；${empRate.toFixed(0)}%-${bossRateV.toFixed(0)}%=${rateD}；${stakeStr}`;
  }

  const evalLbl = (betTarget === 'SKIP') ? (bestLbl || 'A') : betTarget;
  const sel = gaps[evalLbl];
  const d = buildDetail(sel.tier, sel.rate, bossTier, bossRate, sel.tierDiff, sel.rateDiff, betTarget === 'SKIP' ? 'pass' : `投${betAmount}`);

  // ═══════════════════════════════════════════════════════
  // 影子选手决策（内联，与 shadowDecide 逻辑一致）
  // ═══════════════════════════════════════════════════════
  const allVisible = [];
  for (let i = 0; i < 4; i++) allVisible.push(hands[i][0], hands[i][1]);

  // 影子选目标：按 mp 差最大
  let shadowTarget = null;
  let shadowBestGap = -999;
  for (const lbl of ['A', 'B', 'C']) {
    const g = gaps[lbl].mpDiff;
    if (g > shadowBestGap) { shadowBestGap = g; shadowTarget = lbl; }
  }

  // 影子按 mp 差决定倍数
  let shadowMult = 0;
  if (shadowBestGap >= 15) shadowMult = 4;
  else if (shadowBestGap >= 12) shadowMult = 3;
  else if (shadowBestGap >= 9) shadowMult = 2;
  else if (shadowBestGap >= 6) shadowMult = 1;

  // 影子福星卡调整
  if (typeof blessingCards === 'function' && shadowTarget) {
    const targetIdx = ['A', 'B', 'C'].indexOf(shadowTarget) + 1;

    function countBlessingUsed(a, b, visible) {
      const blessings = blessingCards(a, b, visible);
      let maxUsed = 0;
      for (const bInfo of blessings) {
        const used = visible.filter(c => c === bInfo.value).length;
        const weight = bInfo.value === 1 ? 0.5 : 1;
        if (used * weight > maxUsed) maxUsed = used * weight;
      }
      return maxUsed;
    }

    const bossUsed = countBlessingUsed(hands[0][0], hands[0][1], allVisible);
    if (bossUsed >= 2) shadowMult += 1;

    const empUsed = countBlessingUsed(hands[targetIdx][0], hands[targetIdx][1], allVisible);
    if (empUsed >= 2) shadowMult -= 1;
  }

  const stakeMap = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20 };
  const shadowAmount = stakeMap[shadowMult] || 0;

  // ═══════════════════════════════════════════════════════
  // 理性判断：与影子选手决策一致
  // ═══════════════════════════════════════════════════════

  // 情况1：双方都 SKIP
  if (shadowAmount === 0 && betTarget === 'SKIP') {
    return { tag: '理性', detail: d };
  }

  // 情况2：双方都下注，目标相同且金额相同
  if (shadowAmount > 0 && betTarget !== 'SKIP' && betTarget === shadowTarget && betAmount === shadowAmount) {
    return { tag: '理性', detail: d };
  }

  // ═══════════════════════════════════════════════════════
  // 不一致时的冒进/保守判断
  // ═══════════════════════════════════════════════════════

  // 观察者 pass 但影子下注 → 保守（放弃了好机会）
  if (betTarget === 'SKIP') {
    return { tag: '保守', detail: d };
  }

  // 影子 SKIP 但观察者下注 → 冒进（不该出手）
  if (shadowAmount === 0) {
    return { tag: '冒进', detail: d };
  }

  // 两者都下注：金额比较
  if (betAmount > shadowAmount) {
    // 小战力差（相对影子）下大注 → 冒进
    return { tag: '冒进', detail: d };
  }
  if (betAmount < shadowAmount) {
    // 大战力差（相对影子）下小注 → 保守
    return { tag: '保守', detail: d };
  }

  // 金额相同但目标不同
  if (betAmount === shadowAmount && betTarget !== shadowTarget) {
    const obsGap = gaps[betTarget].rateDiff;
    const shadowGapVal = gaps[shadowTarget].rateDiff;
    if (obsGap < shadowGapVal) {
      return { tag: '冒进', detail: d }; // 选了更弱的员工
    } else {
      return { tag: '保守', detail: d };
    }
  }

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

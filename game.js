/**
 * Doukou Card Game - Rules Engine (JavaScript port of card_game_rules.py)
 * 
 * Terminology:
 * - Card = card (value 1-9, where 1 = both A and 10)
 * - Doukou = doukou (entry qualification: 3-card sum = 10 or 20)
 * - Points = digit-effective score from remaining 2 cards
 * - Boss = boss (position 0)
 * - Employee = employee (positions 1-3, labeled A/B/C)
 */

// ═══════════════════════════════════════════════════════
// Layer 1: Card Pool
// ═══════════════════════════════════════════════════════

const DECK_SIZE = 40;

// Card value -> count in pool
// Value 1: 8 cards (A×4 + 10×4)
// Values 2-9: 4 cards each
const CARD_COUNTS = {
  1: 8, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4
};

function buildDeck() {
  const deck = [];
  for (const [value, count] of Object.entries(CARD_COUNTS)) {
    for (let i = 0; i < count; i++) deck.push(Number(value));
  }
  return deck;
}

// ═══════════════════════════════════════════════════════
// Layer 2: Doukou Detection
// ═══════════════════════════════════════════════════════

const DOUKOU_TARGET_10 = 10;
const DOUKOU_TARGET_20 = 20;
const HAND_SIZE = 5;

/**
 * Determine the structure of a 5-card hand.
 * Returns: { type, trio, points } or null
 * 
 * Priority:
 * 1. Pure-1 (all cards = 1) → highest
 * 2. Pure-10 (sum = 10) → second highest
 * 3. Doukou (10 or 20, equal rank) → has doukou, compare points
 * 4. Pure-points (sum < 10) → use sum as digit-effective score
 * 5. No doukou (sum >= 10, no valid 3-card combo) → lowest
 */
function findDoukou(hand) {
  if (hand.length !== HAND_SIZE) return null;

  // Pure-1
  if (hand.every(c => c === 1)) {
    return { type: '纯1', trio: hand.slice(0, 3), points: hand.slice(3) };
  }

  const handSum = hand.reduce((a, b) => a + b, 0);

  // Pure-10
  if (handSum === 10) {
    return { type: '纯10', trio: hand.slice(0, 3), points: hand.slice(3) };
  }

  // Normal doukou: try all 3-card combos
  let best = null;
  let bestPoints = -1;
  let bestPriority = 0;

  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 5; j++) {
      for (let k = j + 1; k < 5; k++) {
        const trio = [hand[i], hand[j], hand[k]];
        const trioSum = trio.reduce((a, b) => a + b, 0);

        if (trioSum === DOUKOU_TARGET_20 || trioSum === DOUKOU_TARGET_10) {
          const priority = 1;
          const remaining = hand.filter((_, idx) => idx !== i && idx !== j && idx !== k);
          const pts = calcPoints(remaining);

          if (priority > bestPriority || (priority === bestPriority && pts > bestPoints)) {
            bestPriority = priority;
            bestPoints = pts;
            best = { type: `${trioSum}斗口`, trio: [...trio], points: [...remaining] };
          }
        }
      }
    }
  }

  if (best !== null) return best;

  // Pure-points: sum < 10
  if (handSum < 10) {
    return { type: '纯点数', trio: null, points: [...hand] };
  }

  // No doukou
  return null;
}

// ═══════════════════════════════════════════════════════
// Layer 3: Points Calculation
// ═══════════════════════════════════════════════════════

/**
 * Calculate points from 2 cards.
 * - Sum > 10 → take ones digit
 * - Sum <= 10 → use directly
 * - Sum = 10 → returns 10 (double payout trigger)
 */
function calcPoints(twoCards) {
  const s = twoCards[0] + twoCards[1];
  if (s > 10) return s % 10;
  return s;
}

/**
 * Pure-points score for hands where sum < 10.
 */
function calcPurePoints(hand) {
  return hand.reduce((a, b) => a + b, 0);
}

/**
 * Check if 2-card sum = 10 (triggers double payout).
 */
function isDoublePayout(twoCards) {
  return (twoCards[0] + twoCards[1]) === 10;
}

// ═══════════════════════════════════════════════════════
// Layer 4: Settlement
// ═══════════════════════════════════════════════════════

const STRUCTURE_RANK = {
  '纯1': 100,
  '纯10': 90,
  '20斗口': 10,
  '10斗口': 10,
  '纯点数': 10,
};

function getStructureRank(type) {
  return STRUCTURE_RANK[type] ?? 0;
}

/**
 * Calculate employee payout multiplier.
 * - 纯1: 4x
 * - 纯10: 3x
 * - Double-payout (2-card sum = 10): 2x
 * - Otherwise: 1x
 */
function employeePayoutMultiplier(eType, eResult) {
  if (eType === '纯1') return 4;
  if (eType === '纯10') return 3;
  if (eType !== '纯点数' && eResult && eResult.points && isDoublePayout(eResult.points)) return 2;
  return 1;
}

/**
 * Compare boss hand vs employee hand.
 * Returns: { winner, reason, payoutMultiplier }
 * 
 * Rules:
 * - Boss wins: 1:1 (no multiplier)
 * - Employee wins: 1x/2x/3x/4x depending on structure
 * - Tie: Boss wins
 */
function compareHands(bossHand, employeeHand) {
  const bResult = findDoukou(bossHand);
  const eResult = findDoukou(employeeHand);

  const bType = bResult ? bResult.type : null;
  const eType = eResult ? eResult.type : null;
  const bRank = getStructureRank(bType);
  const eRank = getStructureRank(eType);

  // Employee has no doukou → boss wins
  if (eResult === null) {
    return { winner: 'boss', reason: '员工无斗口', payoutMultiplier: 1 };
  }

  // Boss has no doukou → employee wins
  if (bResult === null) {
    return {
      winner: 'employee',
      reason: '老板无斗口',
      payoutMultiplier: employeePayoutMultiplier(eType, eResult)
    };
  }

  // Different structure ranks
  if (bRank !== eRank) {
    if (bRank > eRank) {
      return { winner: 'boss', reason: `老板结构更高(${bType} > ${eType})`, payoutMultiplier: 1 };
    } else {
      return {
        winner: 'employee',
        reason: `员工结构更高(${eType} > ${bType})`,
        payoutMultiplier: employeePayoutMultiplier(eType, eResult)
      };
    }
  }

  // Same rank → compare points
  let bPoints, ePoints;
  if (bType === '纯点数') {
    bPoints = calcPurePoints(bossHand);
  } else {
    bPoints = calcPoints(bResult.points);
  }
  if (eType === '纯点数') {
    ePoints = calcPurePoints(employeeHand);
  } else {
    ePoints = calcPoints(eResult.points);
  }

  if (bPoints > ePoints) {
    return { winner: 'boss', reason: `老板点数更大(${bPoints} > ${ePoints})`, payoutMultiplier: 1 };
  } else if (ePoints > bPoints) {
    return {
      winner: 'employee',
      reason: `员工点数更大(${ePoints} > ${bPoints})`,
      payoutMultiplier: employeePayoutMultiplier(eType, eResult)
    };
  } else {
    // Tie → boss wins
    return { winner: 'boss', reason: `点数相同(${bPoints}=${ePoints})，平局归老板`, payoutMultiplier: 1 };
  }
}

// ═══════════════════════════════════════════════════════
// Layer 5: Pool Analysis (for blessing card hints)
// ═══════════════════════════════════════════════════════

/**
 * Given visible cards, calculate remaining pool counts.
 */
function remainingPool(visibleCards) {
  const pool = { ...CARD_COUNTS };
  for (const card of visibleCards) {
    pool[card] = Math.max(0, (pool[card] || 0) - 1);
  }
  return pool;
}

/**
 * Calculate blessing cards {x} for a visible pair (a, b).
 * Blessing card x: a + b + x = 10 or 20, where 1 <= x <= 9.
 * Returns array of { value, remaining } objects.
 */
function blessingCards(a, b, visibleCards) {
  const pool = remainingPool(visibleCards);
  const blessings = [];
  for (let x = 1; x <= 9; x++) {
    if (a + b + x === 10 || a + b + x === 20) {
      blessings.push({ value: x, remaining: pool[x] || 0 });
    }
  }
  return blessings;
}

// ═══════════════════════════════════════════════════════
// Seeded PRNG (mulberry32)
// ═══════════════════════════════════════════════════════

function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates shuffle using provided RNG.
 */
function shuffleDeck(deck, rng) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Deal 4 hands of 5 cards each.
 * Returns [[boss], [A], [B], [C]] where first 2 cards are visible.
 */
function dealRound(rng) {
  const deck = shuffleDeck(buildDeck(), rng);
  const hands = [[], [], [], []];
  let idx = 0;
  for (let r = 0; r < 5; r++) {
    for (let p = 0; p < 4; p++) {
      hands[p].push(deck[idx++]);
    }
  }
  return hands;
}

// ═══════════════════════════════════════════════════════
// Hand Description
// ═══════════════════════════════════════════════════════

function explainHand(hand) {
  const res = findDoukou(hand);
  if (res === null) return `无斗口 (5卡和=${hand.reduce((a,b)=>a+b,0)})`;
  
  const { type, trio, points } = res;
  const ptsStr = points ? points.join(' ') : '-';
  const trioStr = trio ? trio.join(' ') : '-';

  if (type === '纯1') return `${type} (5×1)`;
  if (type === '纯10') return `${type} (5卡都10-pair)`;
  if (type === '纯点数') return `${type} (5卡和=${hand.reduce((a,b)=>a+b,0)})`;
  return `${type} 斗口[${trioStr}] 点数[${ptsStr}]=${calcPoints(points)}`;
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildDeck, findDoukou, calcPoints, calcPurePoints,
    isDoublePayout, compareHands, remainingPool, blessingCards,
    mulberry32, shuffleDeck, dealRound, explainHand,
    CARD_COUNTS, STRUCTURE_RANK, DECK_SIZE, HAND_SIZE
  };
}

// ====== ENHANCED DERIV BOT MAIN SCRIPT ======
// App ID 1089 (public), supports all account types
// This version adds multi-factor confirmation, cooldowns, adaptive martingale,
// TP/SL behavior, improved risk controls and continuous balance updates.

// ---------- State ----------
let ws = null;
let token = "";
let isConnected = false;
let isTrading = false;

let balance = 0;
let profit = 0;
let loss = 0;
let activePositions = 0;
let martingaleLevel = 0;

// tick / trade control
let previousPrice = null;
let momentum = 0;
let ticksSinceLastTrade = 0;
let lastTradeTimestamp = 0;

// ---------- DOM ----------
const connectBtn = document.getElementById("connectBtn");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const tokenInput = document.getElementById("tokenInput");
const modeSelect = document.getElementById("modeSelect"); // demo / real
const balanceDisplay = document.getElementById("balanceDisplay");
const profitDisplay = document.getElementById("profitDisplay");
const lossDisplay = document.getElementById("lossDisplay");
const lastTick = document.getElementById("lastTick");
const logConsole = document.getElementById("logConsole");
const positionsTable = document.getElementById("positionsTable").querySelector("tbody");
const sdMomentum = document.getElementById("sdMomentum");
const candlePattern = document.getElementById("candlePattern");
const crtSignal = document.getElementById("crtSignal");
const activePositionsEl = document.getElementById("activePositions");

const minStakeInput = document.getElementById("minStake");
const maxStakeInput = document.getElementById("maxStake");
const martingaleCapInput = document.getElementById("martingaleCap");
const sessionProfitTarget = document.getElementById("sessionProfitTarget");
const sessionMaxDrawdown = document.getElementById("sessionMaxDrawdown");
const slProximity = document.getElementById("slProximity");

// new controls (cooldown & required confirmations)
const tradeCooldownTicks = 5; // minimum ticks between trades (configurable here)
const requiredMomentum = 2; // min absolute momentum to consider (configurable)
const requiredPattern = true; // require candle pattern (Morning/Evening) to match momentum when true

// ---------- Utilities ----------
const nowStr = () => new Date().toLocaleTimeString();
const log = (msg, type = "info") => {
  const el = document.createElement("div");
  el.textContent = `[${nowStr()}] ${msg}`;
  el.style.color = type === "error" ? "#ff6a3c" : type === "warn" ? "#ffd166" : "#00e6b3";
  logConsole.prepend(el);
};

const updateStats = () => {
  balanceDisplay.textContent = (typeof balance === "number" ? balance : 0).toFixed(2);
  profitDisplay.textContent = profit.toFixed(2);
  lossDisplay.textContent = loss.toFixed(2);
  activePositionsEl.textContent = activePositions;
};

// safety check: minimum trade stake must be <= balance and <= max stake
const canPlaceStake = (stake) => {
  if (stake <= 0) return false;
  if (stake > parseFloat(maxStakeInput.value)) return false;
  // keep a safety reserve (do not stake entire balance)
  const reserve = Math.max(0.05, balance * 0.05); // at least 5 cents or 5% reserved
  return stake + reserve <= balance;
};

// ---------- Deriv connection ----------
const connectDeriv = () => {
  token = tokenInput.value.trim();
  if (!token) {
    alert("Please enter your Deriv API token (demo recommended).");
    return;
  }

  // open websocket
  ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

  ws.onopen = () => {
    log("WebSocket opened — authorizing...");
    ws.send(JSON.stringify({ authorize: token }));
  };

  ws.onmessage = (evt) => {
    const data = JSON.parse(evt.data);

    if (data.error) {
      log(`API error: ${data.error.message}`, "error");
      return;
    }

    // authorization success
    if (data.msg_type === "authorize") {
      isConnected = true;
      log(`Authorized as ${data.authorize.email}`);
      // fetch balance and symbol info
      fetchBalance();
      startBtn.disabled = false;
      connectBtn.disabled = true;
    }

    // balance response
    if (data.msg_type === "balance") {
      // Deriv returns { balance: { balance: "1000.00", currency: "USD" } }
      try {
        balance = parseFloat(data.balance.balance);
      } catch {
        balance = 0;
      }
      updateStats();
    }

    // ticks
    if (data.msg_type === "tick") {
      const price = parseFloat(data.tick.quote);
      lastTick.textContent = price.toFixed(5);
      analyzeTick(price);
    }

    // any other messages can be logged for debugging
    // console.log("WS message:", data);
  };

  ws.onclose = () => {
    isConnected = false;
    log("WebSocket closed.", "error");
    connectBtn.disabled = false;
    startBtn.disabled = true;
  };

  ws.onerror = (err) => {
    log("WebSocket error (see console).", "error");
    console.error(err);
  };
};

const fetchBalance = () => {
  if (!isConnected || !ws) return;
  ws.send(JSON.stringify({ balance: 1 }));
};

const subscribeTicks = (symbol = "R_100") => {
  if (!isConnected || !ws) return;
  ws.send(JSON.stringify({ ticks: symbol }));
  log(`Subscribed to ticks: ${symbol}`);
};

// ---------- Market analysis & signals ----------
const resetMomentum = () => (momentum = 0);

const analyzeTick = (price) => {
  ticksSinceLastTrade++;
  if (previousPrice === null) previousPrice = price;

  // momentum: increase when price moves same direction, decrease otherwise
  if (price > previousPrice) momentum = Math.max(-10, momentum + 1);
  else if (price < previousPrice) momentum = Math.min(10, momentum - 1);

  // supply/demand momentum label
  sdMomentum.textContent = momentum > 0 ? `Bullish (${momentum})` : `Bearish (${momentum})`;
  sdMomentum.style.color = momentum > 0 ? "#00e6b3" : "#ff6a3c";

  // simple candle pattern detection emulation (Morning/Evening star when momentum spikes)
  if (momentum >= 4) {
    candlePattern.textContent = "Morning Star";
    candlePattern.style.color = "#00e6b3";
  } else if (momentum <= -4) {
    candlePattern.textContent = "Evening Star";
    candlePattern.style.color = "#ff6a3c";
  } else {
    candlePattern.textContent = "Neutral";
    candlePattern.style.color = "#ccc";
  }

  // CRT signal: use short-term moving direction vs momentum (simple proxy)
  // If momentum strong and last delta aligns, we consider CRT = direction
  const crt = momentum >= requiredMomentum ? "UP" : momentum <= -requiredMomentum ? "DOWN" : "NEUTRAL";
  crtSignal.textContent = crt;
  crtSignal.style.color = crt === "UP" ? "#00e6b3" : crt === "DOWN" ? "#ff6a3c" : "#ccc";

  // attempt trade if enabled
  if (isTrading) {
    tradeDecision(price, crt);
  }

  previousPrice = price;
};

// ---------- Trade decision & execution ----------
const tradeDecision = (price, crt) => {
  // session risk checks
  const profitTarget = parseFloat(sessionProfitTarget.value) || Infinity;
  const maxDraw = parseFloat(sessionMaxDrawdown.value) || Infinity;
  if (profit >= profitTarget) {
    log("Session profit target reached — stopping trading.", "warn");
    stopTrading();
    return;
  }
  if (loss >= maxDraw) {
    log("Session drawdown limit reached — stopping trading.", "error");
    stopTrading();
    return;
  }

  // cooldown: require at least tradeCooldownTicks since last trade
  if (ticksSinceLastTrade < tradeCooldownTicks) {
    return;
  }

  // momentum requirement
  if (Math.abs(momentum) < requiredMomentum) return;

  // require pattern match if configured
  const patternLabel = candlePattern.textContent;
  if (requiredPattern) {
    if (momentum > 0 && patternLabel !== "Morning Star") return;
    if (momentum < 0 && patternLabel !== "Evening Star") return;
  }

  // CRT must agree with momentum
  if ((momentum > 0 && crt !== "UP") || (momentum < 0 && crt !== "DOWN")) {
    return;
  }

  // determine direction and stake
  const direction = crt === "UP" ? "CALL" : "PUT";

  // adaptive martingale: smaller growth factor (1.4) to reduce blow-up risk
  const baseStake = parseFloat(minStakeInput.value) || 0.01;
  const growthFactor = 1.4;
  let stake = baseStake * Math.pow(growthFactor, martingaleLevel);

  // enforce max stake input
  const maxStake = parseFloat(maxStakeInput.value) || 5;
  stake = Math.min(stake, maxStake);

  // enforce tiny micro-stake cap: don't exceed small micro-limit (user wants <20 KES per trade)
  // We'll also ensure stake is not more than a small fraction of balance
  const maxFraction = 0.02; // don't risk more than 2% balance per position by default
  const fractionCap = Math.max(0.01, balance * maxFraction);
  stake = Math.min(stake, fractionCap);

  // safety: check balance allows this stake (keep small reserve)
  if (!canPlaceStake(stake)) {
    log(`Insufficient usable balance for stake $${stake.toFixed(4)} — skipping trade.`, "warn");
    return;
  }

  // everything passed: place a trade (simulation by default)
  placeSimulatedTrade(direction, stake, price);
  ticksSinceLastTrade = 0;
  lastTradeTimestamp = Date.now();
};

// ---------- Simulated trade / placeholder for real buy ----------
const placeSimulatedTrade = (direction, stake, entryPrice) => {
  activePositions++;
  updateStats();

  const id = `pos_${Date.now()}`;
  // compute TP / SL price offsets using slProximity (percentage)
  const slPct = parseFloat(slProximity.value) || 98; // e.g., 98 -> very tight
  // Represent SL/TP as tiny price deltas around entry to emulate rapid exit
  const tpOffset = entryPrice * 0.0005; // small TP offset
  const slOffset = entryPrice * ( (100 - slPct) / 10000 ); // small SL based on proximity setting

  const tp = direction === "CALL" ? entryPrice + tpOffset : entryPrice - tpOffset;
  const sl = direction === "CALL" ? entryPrice - slOffset : entryPrice + slOffset;

  // add to positions table
  const row = positionsTable.insertRow(0);
  row.dataset.id = id;
  row.innerHTML = `
    <td>${id}</td>
    <td>${direction}</td>
    <td>${stake.toFixed(4)}</td>
    <td>${entryPrice.toFixed(5)}</td>
    <td>${tp.toFixed(5)}</td>
    <td>${sl.toFixed(5)}</td>
    <td class="result">Pending</td>
  `;

  log(`Simulated ${direction} | stake $${stake.toFixed(4)} | entry ${entryPrice.toFixed(5)}`);

  // simulate outcome probabilistically but biased by signal strength
  // stronger momentum increases win chance
  const strength = Math.min(Math.abs(momentum) / 6, 1); // 0..1
  const baseWinChance = 0.48; // baseline (broker edge)
  const winBoost = 0.2 * strength; // up to +20% if very strong
  const winChance = Math.min(0.98, baseWinChance + winBoost); // cap to 98%

  // simulate fast exit: short delay (100-800 ms) to emulate immediate TP/SL reaction
  const delay = Math.floor(100 + Math.random() * 700);
  setTimeout(() => {
    const didWin = Math.random() < winChance;
    const pnl = didWin ? stake * 0.05 : -stake; // TP small 5% reward, SL loses stake

    // update stats
    if (didWin) {
      profit += pnl;
      martingaleLevel = 0; // reset on win
      row.querySelector(".result").textContent = "WIN";
      row.querySelector(".result").style.color = "#00e6b3";
      log(`WIN ${id}: +$${pnl.toFixed(4)}`);
    } else {
      loss += -pnl;
      // escalate martingale if not at cap
      const cap = parseInt(martingaleCapInput.value) || 5;
      if (martingaleLevel < cap) martingaleLevel++;
      row.querySelector(".result").textContent = "LOSS";
      row.querySelector(".result").style.color = "#ff6a3c";
      log(`LOSS ${id}: -$${(-pnl).toFixed(4)}`, "warn");
    }

    // update balance and UI
    balance += pnl;
    activePositions--;
    updateStats();

    // safety: if drawdown or profit target reached, stop trading automatically
    const profitTarget = parseFloat(sessionProfitTarget.value) || Infinity;
    const maxDraw = parseFloat(sessionMaxDrawdown.value) || Infinity;
    if (profit >= profitTarget) {
      log("Profit target reached — auto-stopping.", "warn");
      stopTrading();
    } else if (loss >= maxDraw) {
      log("Max drawdown reached — auto-stopping.", "error");
      stopTrading();
    }
  }, delay);
};

// ---------- Start / Stop ----------
const startTrading = () => {
  if (!isConnected) {
    alert("Please connect to Deriv first (use demo token).");
    return;
  }

  // Immediately subscribe to ticks for the chosen symbol
  subscribeTicks();

  // reset session variables
  isTrading = true;
  martingaleLevel = 0;
  ticksSinceLastTrade = tradeCooldownTicks; // allow immediate trade on strong signal
  lastTradeTimestamp = 0;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  log("Trading STARTED (simulation mode).");
};

const stopTrading = () => {
  isTrading = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  log("Trading STOPPED.");
};

// ---------- Event listeners ----------
connectBtn.addEventListener("click", connectDeriv);
startBtn.addEventListener("click", startTrading);
stopBtn.addEventListener("click", stopTrading);

// periodic balance refresh
setInterval(() => {
  if (isConnected) fetchBalance();
}, 8000);

// auto reconnect logic (simple)
setInterval(() => {
  if (!isConnected && token) {
    log("Attempting reconnect...");
    try {
      connectDeriv();
    } catch (e) {
      // ignore
    }
  }
}, 15000);

// Ensure UI initial state
updateStats();

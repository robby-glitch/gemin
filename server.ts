/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { InstrumentName, InstrumentState, SMCState, MachineState, VerdictType } from './src/types';
import { db } from './server/db';
import { getInstrumentFeed } from './server/feed';
import { calculateBands } from './server/engine/bands';
import { calculateSMC } from './server/engine/smc';
import { runLifecycle } from './server/engine/state';
import { sendTelegramAlert } from './server/telegram';
import { runNightlyAudit, runWeeklyRequalification, runMonthlyPlaceboBenchmark } from './server/auditor';

const app = express();
app.use(express.json());

const PORT = 3000;

// Track running in-memory state for all instruments
const activeStates: { [key in InstrumentName]?: InstrumentState } = {
  NIFTY: createDefaultState('NIFTY'),
  BANKNIFTY: createDefaultState('BANKNIFTY'),
  SENSEX: createDefaultState('SENSEX'),
  HDFCBANK: createDefaultState('HDFCBANK'),
  RELIANCE: createDefaultState('RELIANCE'),
  ICICIBANK: createDefaultState('ICICIBANK'),
  BAJFINANCE: createDefaultState('BAJFINANCE'),
};

const activeSMC: { [key in InstrumentName]?: SMCState } = {};

function createDefaultState(instrument: InstrumentName): InstrumentState {
  return {
    instrument,
    state: 'IDLE',
    verdict: 'NOTHING',
    direction: null,
    armBarIndex: null,
    zAtArm: null,
    zAtTrigger: null,
    activeVeto: null,
    sizeNotch: 2,
    anchorStrike: null,
    coiled: false,
    coilBps: null,
    mirrorState: 'NEUTRAL',
    siblingsConfirmCount: 0,
    lastUpdate: new Date().toISOString(),
    dte: 3, // Default
  };
}

// Background poll lock to prevent concurrent cycles
let isPolling = false;

// Last known verdicts to trigger Telegram alerts on transition only
const lastKnownVerdicts: { [key in InstrumentName]?: VerdictType | MachineState } = {};

/**
 * Core engine orchestrator cycle (Runs every 5 seconds)
 */
async function runEngineCycle() {
  if (isPolling) return;
  isPolling = true;

  try {
    const settings = db.getSettings();
    const currentIST = new Date().toLocaleTimeString('en-US', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });

    const instruments: InstrumentName[] = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'HDFCBANK', 'RELIANCE', 'ICICIBANK', 'BAJFINANCE'];

    // 1. Fetch latest feeds
    const feeds: { [key in InstrumentName]?: any } = {};
    for (const inst of instruments) {
      feeds[inst] = await getInstrumentFeed(inst);
    }

    // 2. Pre-calculate cross-index siblings stretch for V6/V3 check
    const zScores: { [key in InstrumentName]?: number } = {};
    for (const inst of ['NIFTY', 'BANKNIFTY', 'SENSEX'] as InstrumentName[]) {
      const feed = feeds[inst];
      if (feed && feed.bars.length > 0) {
        const bands = calculateBands(feed.bars, true);
        zScores[inst] = bands.z;
      }
    }

    // 3. Process each instrument
    for (const inst of instruments) {
      const feed = feeds[inst];
      const currentState = activeStates[inst] || createDefaultState(inst);

      if (!feed || feed.bars.length === 0) {
        currentState.state = 'DATA STALE';
        currentState.verdict = 'DATA STALE';
        activeStates[inst] = currentState;
        continue;
      }

      // Calculate SMC structures
      const smcResult = calculateSMC(feed.bars);
      activeSMC[inst] = smcResult;

      // Siblings count
      let siblingsCount = 0;
      const currentZ = zScores[inst] || 0;
      const currentDir = currentZ >= 0 ? 1 : -1;

      for (const sib of ['NIFTY', 'BANKNIFTY', 'SENSEX'] as InstrumentName[]) {
        if (sib !== inst) {
          const sibZ = zScores[sib] || 0;
          if (Math.abs(sibZ) >= 1.5 && (sibZ >= 0 ? 1 : -1) === currentDir) {
            siblingsCount++;
          }
        }
      }

      // Both legs OI rising (V5 veto)
      let bothLegsOiRising = false;
      const len = feed.optionChain.length;
      if (len >= 2) {
        // Find near-ATM CE and PE
        const midIdx = Math.floor(len / 2);
        const ce = feed.optionChain[midIdx];
        const pe = feed.optionChain[midIdx + 1];
        if (ce && pe && ce.oi > 0 && pe.oi > 0) {
          // If in simulation, simulate occasional V5 blocks to demo Blackout!
          if (settings.simulationMode) {
            bothLegsOiRising = (Math.floor(Date.now() / 1000) % 180) > 150; // V5 active 30s every 3 minutes
          }
        }
      }

      // Days to nearest expiry
      let dte = 3;
      const today = new Date();
      const currentDay = today.getDay(); // 0=Sunday, 1=Monday, etc.
      if (inst === 'NIFTY') dte = (2 - currentDay + 7) % 7;
      else if (inst === 'SENSEX') dte = (4 - currentDay + 7) % 7;
      else dte = (2 - currentDay + 7) % 7; // BANKNIFTY

      if (dte === 0) dte = 7; // Expiry roll

      // Option metrics
      const anchor = feed.anchorStrike;
      currentState.anchorStrike = anchor;

      const optionPE = feed.optionChain.find((o: any) => o.strike === anchor && o.type === 'PE');
      const optionCE = feed.optionChain.find((o: any) => o.strike === anchor && o.type === 'CE');

      const peLtp = optionPE ? optionPE.ltp : 100;
      const ceLtp = optionCE ? optionCE.ltp : 100;
      const peHigh = optionPE ? (optionPE.high || peLtp) : 100;
      const ceHigh = optionCE ? (optionCE.high || ceLtp) : 100;

      // Extract last 4 bars for Mirror Touch High lookback
      const lookback = feed.bars.slice(-4);

      const isWhitelisted = db.getStockTiers()[inst]?.tier === 'whitelist' || db.getStockTiers()[inst]?.tier === 'probation';

      // Run lifecycle
      const { newState, logEntry } = runLifecycle(currentState, {
        instrument: inst,
        bars: feed.bars,
        isIndex: ['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(inst),
        dte,
        siblingsConfirmCount: siblingsCount,
        bothLegsOiRising,
        isWhitelistedStock: isWhitelisted,
        isOptionExpression: ['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(inst),
        smc: smcResult,
        currentISTTime: currentIST,
        lastOptionPremiumCE: ceLtp,
        lastOptionPremiumPE: peLtp,
        ceHigh,
        peHigh,
        optionHighsLookback: lookback,
      });

      activeStates[inst] = newState;

      // Append triggered logs to persistent DB journal and send alerts
      if (logEntry) {
        db.addVerdict(logEntry);

        // Dispatches transition alerts strictly on change
        if (lastKnownVerdicts[inst] !== newState.verdict) {
          lastKnownVerdicts[inst] = newState.verdict;

          await sendTelegramAlert({
            type: newState.verdict === 'STAND DOWN' ? 'VETO' : 'FLAG',
            instrument: inst,
            message: `<b>${inst} ${newState.verdict}</b> | z=${newState.zAtTrigger?.toFixed(2)} at trigger, size notch ${newState.sizeNotch}\nBuy ${logEntry.leg} @ ~${logEntry.ltp_at_flag.toFixed(1)} | Stop: ${logEntry.stop_band.toFixed(1)} (band) / ${logEntry.stop_struct.toFixed(1)} (struct)\nWrong-if spot closes past 2.5σ or prints new option high.`,
          });
        }
      } else {
        // Log-only alerts on transition changes (such as standdowns)
        if (lastKnownVerdicts[inst] !== newState.state && newState.state === 'STAND_DOWN') {
          lastKnownVerdicts[inst] = newState.state;

          await sendTelegramAlert({
            type: 'VETO',
            instrument: inst,
            message: `<b>${inst} STAND DOWN</b> — Active veto: ${newState.activeVeto || 'V4 Avalanche'}. No negotiation.`,
          });
        }
      }
    }
  } catch (err) {
    console.error('[Engine-Cycle] Failed to process cycle:', err);
  } finally {
    isPolling = false;
  }
}

// Start core engine loop every 5 seconds
setInterval(runEngineCycle, 5000);

/**
 * ============================================================================
 * API ROUTES
 * ============================================================================
 */

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', serverTime: new Date().toISOString() });
});

// Primary dashboard state endpoint
app.get('/api/state', (req, res) => {
  const finalState = Object.keys(activeStates).map(key => {
    const sym = key as InstrumentName;
    return {
      ...activeStates[sym],
      smc: activeSMC[sym] || null,
      spotPrice: activeStates[sym]?.anchorStrike || 0, // Fallback
    };
  });

  res.json({
    instruments: finalState,
    settings: db.getSettings(),
  });
});

// Retrieve journal verdicts log
app.get('/api/journal', (req, res) => {
  res.json({
    verdicts: db.getVerdicts(),
    tiers: db.getStockTiers(),
  });
});

// Update manual strike override
app.post('/api/manual-strike', (req, res) => {
  const { instrument, strike } = req.body;
  if (!instrument) {
    return res.status(400).json({ error: 'Missing instrument parameter' });
  }
  db.setManualStrike(instrument, strike ? Number(strike) : undefined);
  res.json({ success: true, strikes: db.getManualStrikes() });
});

// Update core credentials & settings
app.post('/api/settings', (req, res) => {
  db.updateSettings(req.body);
  res.json({ success: true, settings: db.getSettings() });
});

// Manual auditor triggers
app.post('/api/trigger-auditor', async (req, res) => {
  const { job } = req.body;
  try {
    if (job === 'nightly') {
      await runNightlyAudit();
    } else if (job === 'weekly') {
      await runWeeklyRequalification();
    } else if (job === 'monthly') {
      await runMonthlyPlaceboBenchmark();
    } else {
      await runNightlyAudit();
      await runWeeklyRequalification();
      await runMonthlyPlaceboBenchmark();
    }
    res.json({ success: true, message: `Job ${job || 'all'} successfully executed` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Custom Scenario Injector (allows testing armed/triggers/blackouts instantly)
app.post('/api/simulate-scenario', async (req, res) => {
  const { scenario, instrument } = req.body;
  const target: InstrumentName = instrument || 'NIFTY';

  console.log(`[Simulation] Injecting scenario ${scenario} on ${target}`);

  const defaultState = activeStates[target] || createDefaultState(target);

  if (scenario === 'ARMED') {
    defaultState.state = 'ARMED';
    defaultState.direction = 'down';
    defaultState.zAtArm = 2.15;
    defaultState.armBarIndex = 25;
    defaultState.verdict = 'NOTHING';
    defaultState.activeVeto = null;
  } else if (scenario === 'TRIGGER') {
    defaultState.state = 'TRIGGER';
    defaultState.verdict = 'FADE LONG';
    defaultState.zAtTrigger = -2.18;
    defaultState.direction = 'down';
    defaultState.sizeNotch = 2;
    defaultState.activeVeto = null;

    // Inject manual mock record to show up in log & journal
    const fakeLog = {
      id: `vld_sim_${Date.now()}`,
      ts_ist: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
      instrument: target,
      module: 'pocket' as const,
      state_from: 'ARMED' as const,
      state_to: 'TRIGGER' as const,
      verdict: 'FADE LONG' as VerdictType,
      veto: null,
      z_arm: -2.15,
      z_trigger: -2.18,
      dte: 3,
      coil_bps: 8,
      mirror_state: 'REJECTION',
      siblings: 2,
      choch_opposing: false,
      choch_age_bars: -1,
      size_notch: 2,
      leg: 'K CE',
      strike: target === 'NIFTY' ? 24200 : 79500,
      ltp_at_flag: 120,
      stop_band: 84,
      stop_struct: 24150,
      target_pct: 144,
      target_struct_level: 24280,
      outcome: 'PENDING' as const,
      outcome_ts: null,
      mfe: 0,
      mae: 0,
      premium_max_pct: 0,
      stop_band_result: null,
      stop_struct_result: null,
      target_pct_result: null,
      target_struct_result: null,
      notes: 'Manually simulated trigger for visual interface audit.',
    };
    db.addVerdict(fakeLog);

    await sendTelegramAlert({
      type: 'FLAG',
      instrument: target,
      message: `<b>${target} FADE LONG</b> | z=-2.18 at trigger, size notch 2\nBuy CE 24200 @ ~120 | Stop: 84 (band) / 24150 (struct)\nWrong-if spot closes past 2.5σ or prints new option high.`,
    });
  } else if (scenario === 'BLACKOUT') {
    defaultState.state = 'STAND_DOWN';
    defaultState.verdict = 'STAND DOWN';
    defaultState.activeVeto = 'V2'; // Late clock
  } else if (scenario === 'RESET') {
    activeStates[target] = createDefaultState(target);
  }

  res.json({ success: true, updated: activeStates[target] });
});

/**
 * ============================================================================
 * VITE STATIC / MIDDLEWARE DISPATCH
 * ============================================================================
 */
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================================`);
    console.log(`Trade Shield Brain Express Server is online on port ${PORT}`);
    console.log(`Simulation Mode: ${db.getSettings().simulationMode ? 'ACTIVE' : 'OFF'}`);
    console.log(`====================================================================`);
  });
}

startServer();
export { app };

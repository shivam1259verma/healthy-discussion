// ── Build waveform bars ──────────────────────────────────────
const BAR_COUNT = 32;
const barsEl = document.getElementById('volBars');
const bars = [];
for (let i = 0; i < BAR_COUNT; i++) {
  const b = document.createElement('div');
  b.className = 'vol-bar';
  barsEl.appendChild(b);
  bars.push(b);
}

// ── State ────────────────────────────────────────────────────
let audioCtx, stream, analyser, dataArr, animFrame;
let silThresh = -55, jumpThresh = 8, loudThreshDb = -10, holdMs = 500;

// Rolling baseline: average dB during speech (one person talking)
// We track a slow-moving average of the "quiet speech" level
let baseline = null;          // dB of one-speaker baseline
let baselineSamples = [];     // collected during calibration
let calibrating = false;
let calibStart = 0;
const CALIB_DURATION = 3000; // 3 s silence calibration

// Overlap detection: flag when current dB jumps significantly above baseline
let overlapTimer = null;
let overlapActive = false;
let lastBuzz = 0;

// Sliders
document.getElementById('silThresh').oninput  = e => { silThresh    = +e.target.value; document.getElementById('silThreshVal').textContent  = silThresh    + ' dB'; };
document.getElementById('jumpThresh').oninput = e => { jumpThresh   = +e.target.value; document.getElementById('jumpThreshVal').textContent = '+' + jumpThresh + ' dB'; };
document.getElementById('loudThresh').oninput = e => { loudThreshDb = +e.target.value; document.getElementById('loudThreshVal').textContent = loudThreshDb  + ' dB'; };
document.getElementById('holdMs').oninput     = e => { holdMs       = +e.target.value; document.getElementById('holdMsVal').textContent     = holdMs        + ' ms'; };

// ── Helpers ──────────────────────────────────────────────────
function getDb() {
  analyser.getByteFrequencyData(dataArr);
  let sum = 0;
  for (let i = 0; i < dataArr.length; i++) sum += dataArr[i] * dataArr[i];
  const rms = Math.sqrt(sum / dataArr.length);
  return rms < 1 ? -100 : 20 * Math.log10(rms / 255);
}

function pct(db) { return Math.max(0, Math.min(100, ((db + 80) / 80) * 100)); }

function buzz() {
  if (!audioCtx) return;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(220, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(60, audioCtx.currentTime + 0.5);
  gain.gain.setValueAtTime(0.4, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + 0.5);
}

function triggerAlert(msg, type) {
  const now = Date.now();
  if (now - lastBuzz < 1200) return;
  lastBuzz = now;
  buzz();
  const f = document.getElementById('flash');
  f.classList.remove('show'); void f.offsetWidth; f.classList.add('show');
  addLog(msg, type || 'bad');
}

function setStatus(cls, label, labelColor, icon, desc) {
  const b = document.getElementById('statusBanner');
  b.className = cls ? cls : '';
  document.getElementById('sIcon').textContent  = icon;
  const sl = document.getElementById('sLabel');
  sl.textContent  = label;
  sl.style.color  = labelColor;
  document.getElementById('sDesc').textContent  = desc;
}

function setChips(active) {
  ['Silence','One','Overlap','Loud'].forEach(name => {
    document.getElementById('chip' + name).classList.toggle('on', active === name);
  });
}

function addLog(msg, type) {
  const el    = document.getElementById('logEl');
  const entry = document.createElement('div');
  entry.className = 'log-entry' + (type ? ' ' + type : '');
  const ts    = new Date().toLocaleTimeString('en', {hour12:false});
  entry.innerHTML = `<span class="ts">${ts}</span><span>${msg}</span>`;
  el.appendChild(entry);
  el.scrollTop = el.scrollHeight;
}

// ── Calibration (measure silence floor) ─────────────────────
function runCalibration() {
  calibrating  = true;
  baselineSamples = [];
  calibStart   = Date.now();
  document.getElementById('calibBar').style.display = 'block';
  setStatus('listening','CALIBRATING','var(--accent)','⏳','Stay silent for 3 seconds…');
}

// ── Main loop ────────────────────────────────────────────────
// How it works:
// 1. We measure one dB value from the mic (the room).
// 2. During calibration we record the silence floor.
// 3. After calibration:
//    - db < silThresh  → silence
//    - db > loudThreshDb → shouting
//    - db > (baseline + jumpThresh) → overlap (second voice has joined)
//    - otherwise → single speaker
//
// "baseline" is updated slowly as a moving average only during single-speaker state.

let smoothDb = -100;   // smoothed dB for display
let oneSpeakerBaseline = null;  // running average when single speaker detected
let baselineTimer = 0;

function loop() {
  animFrame = requestAnimationFrame(loop);

  const rawDb = getDb();
  // Smooth display
  smoothDb = smoothDb * 0.75 + rawDb * 0.25;

  // Update waveform bars
  analyser.getByteFrequencyData(dataArr);
  const step = Math.floor(dataArr.length / BAR_COUNT);
  for (let i = 0; i < BAR_COUNT; i++) {
    const val = dataArr[i * step] / 255;
    bars[i].style.height = Math.max(3, val * 40) + 'px';
    bars[i].style.opacity = 0.4 + val * 0.6;
  }

  // Update volume fill
  const fill = document.getElementById('volFill');
  fill.style.width = pct(smoothDb) + '%';
  document.getElementById('dbNow').textContent = smoothDb > -90 ? smoothDb.toFixed(1) + ' dB' : '-- dB';

  // ── Calibration phase ──
  if (calibrating) {
    const elapsed = Date.now() - calibStart;
    document.getElementById('calibFill').style.width = Math.min(100, (elapsed / CALIB_DURATION) * 100) + '%';
    if (rawDb > silThresh + 10) {
      // Someone spoke — restart calibration
      baselineSamples = [];
      calibStart = Date.now();
      addLog('Noise detected, recalibrating…', 'warn');
    } else {
      baselineSamples.push(rawDb);
    }
    if (elapsed >= CALIB_DURATION) {
      calibrating = false;
      document.getElementById('calibBar').style.display = 'none';
      const avg = baselineSamples.reduce((a,b) => a+b, 0) / baselineSamples.length;
      baseline = avg;
      oneSpeakerBaseline = null;
      document.getElementById('dbBase').textContent = 'baseline: ' + avg.toFixed(1) + ' dB';
      addLog('Calibration done. Silence floor: ' + avg.toFixed(1) + ' dB', 'good');
      setStatus('listening','MONITORING','var(--accent)','👂','Listening for speech…');
    }
    return;
  }

  if (baseline === null) return; // still waiting for calibration

  // ── Detection ──
  const isSilent  = rawDb < silThresh;
  const isLoud    = rawDb > loudThreshDb;

  // Update one-speaker baseline slowly (only when a single person is speaking moderately)
  // This adapts to the room's normal conversation volume
  if (!isSilent && !isLoud && !overlapActive) {
    if (oneSpeakerBaseline === null) {
      oneSpeakerBaseline = rawDb;
    } else {
      // Slow exponential moving average — adapts over ~5 seconds
      oneSpeakerBaseline = oneSpeakerBaseline * 0.97 + rawDb * 0.03;
    }
    document.getElementById('dbBase').textContent = 'one-speaker: ' + oneSpeakerBaseline.toFixed(1) + ' dB';
  }

  // Overlap = current volume jumps well above the established one-speaker level
  const refLevel = oneSpeakerBaseline !== null ? oneSpeakerBaseline : (baseline + 15);
  const isOverlap = !isSilent && !isLoud && (rawDb > refLevel + jumpThresh);

  // ── Update avatars ──
  const aA = document.getElementById('avatarA');
  const aB = document.getElementById('avatarB');

  if (isLoud) {
    aA.className = 'avatar loud'; aB.className = 'avatar loud';
    fill.className = 'vol-fill loud';
  } else if (isOverlap || overlapActive) {
    aA.className = 'avatar overlap'; aB.className = 'avatar overlap';
    fill.className = 'vol-fill overlap';
  } else if (!isSilent) {
    // Alternate A/B active based on small random fluctuations (visual only)
    aA.className = 'avatar active'; aB.className = 'avatar';
    fill.className = 'vol-fill speaking';
  } else {
    aA.className = 'avatar'; aB.className = 'avatar';
    fill.className = 'vol-fill';
  }

  // ── State machine ──
  if (isLoud) {
    document.getElementById('voicePanel').className = 'voice-panel loud';
    setStatus('unhealthy','UNHEALTHY DISCUSSION','var(--red)','🔊','Someone is speaking too loudly!');
    setChips('Loud');
    triggerAlert('🔊 Loud voice detected (' + rawDb.toFixed(1) + ' dB)');

  } else if (isOverlap) {
    if (!overlapTimer) {
      overlapTimer = setTimeout(() => {
        overlapActive = true;
        document.getElementById('voicePanel').className = 'voice-panel over';
        setStatus('unhealthy','UNHEALTHY DISCUSSION','var(--red)','🚫','Both speakers talking at once!');
        setChips('Overlap');
        triggerAlert('⚡ Overlap — two voices detected simultaneously');
        overlapTimer = null;
      }, 250); // short debounce so brief spikes don't false-trigger
    }

  } else {
    // Clear overlap once volume drops back
    if (overlapTimer) { clearTimeout(overlapTimer); overlapTimer = null; }
    if (overlapActive) {
      // Keep overlap flag for holdMs so the banner stays up briefly
      setTimeout(() => {
        overlapActive = false;
        document.getElementById('voicePanel').className = 'voice-panel' + (!isSilent ? ' one' : '');
      }, holdMs);
    }

    if (isSilent) {
      if (!overlapActive) {
        document.getElementById('voicePanel').className = 'voice-panel';
        setStatus('','SILENCE','var(--muted)','🤫','No speech detected');
        setChips('Silence');
      }
    } else {
      if (!overlapActive) {
        document.getElementById('voicePanel').className = 'voice-panel one';
        setStatus('healthy','HEALTHY DISCUSSION','var(--green)','✅','One person speaking — good turn-taking');
        setChips('One');
      }
    }
  }
}

// ── Start / Stop ─────────────────────────────────────────────
async function startMonitoring() {
  document.getElementById('micError').style.display = 'none';
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    stream   = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    dataArr  = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);

    document.getElementById('btnStart').style.display = 'none';
    document.getElementById('btnStop').style.display  = 'inline-block';
    addLog('Microphone connected', 'good');
    runCalibration();
    loop();
  } catch(err) {
    document.getElementById('micError').style.display = 'block';
    document.getElementById('micErrorMsg').textContent = err.message || 'Access denied';
    addLog('Mic error: ' + (err.message || 'denied'), 'bad');
  }
}

function stopMonitoring() {
  if (animFrame) cancelAnimationFrame(animFrame);
  if (overlapTimer) clearTimeout(overlapTimer);
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close();
  analyser = null; baseline = null; oneSpeakerBaseline = null;
  calibrating = false; overlapActive = false;
  document.getElementById('calibBar').style.display = 'none';
  document.getElementById('btnStart').style.display = '';
  document.getElementById('btnStop').style.display  = 'none';
  document.getElementById('voicePanel').className   = 'voice-panel';
  document.getElementById('volFill').style.width    = '0%';
  document.getElementById('dbNow').textContent      = '-- dB';
  document.getElementById('dbBase').textContent     = 'baseline: -- dB';
  ['avatarA','avatarB'].forEach(id => document.getElementById(id).className = 'avatar');
  bars.forEach(b => { b.style.height = '3px'; });
  setChips('');
  setStatus('','WAITING','var(--muted)','🎙️','Press Start to begin monitoring');
  addLog('Monitoring stopped', '');
}

document.getElementById('btnStart').addEventListener('click', startMonitoring);
document.getElementById('btnStop').addEventListener('click', stopMonitoring);

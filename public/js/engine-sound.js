/**
 * Synthesized vehicle engine sound using WebAudio API.
 * Two modes: 'bus' (diesel) and 'tram' (electric).
 *
 * Usage:
 *   const engine = createEngineSound();
 *   engine.start('bus');   // or 'tram'
 *   engine.setRPM(0.15);   // idle
 *   engine.setRPM(0.8);    // cruising
 *   engine.stop();
 */

function createEngineSound() {
  let ctx = null;
  let masterGain = null;
  let nodes = [];          // all created nodes for cleanup
  let animFrameId = null;
  let currentRPM = 0;
  let targetRPM = 0;
  let type = null;
  let running = false;

  // Lerp speed: how fast currentRPM approaches targetRPM (0-1 per second)
  const LERP_SPEED = 3.0;
  let lastUpdateTime = 0;

  // Noise buffer (shared, created once)
  let noiseBuffer = null;

  function createNoiseBuffer(audioCtx, duration = 2) {
    const sampleRate = audioCtx.sampleRate;
    const length = sampleRate * duration;
    const buffer = audioCtx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.5;
    }
    return buffer;
  }

  function buildDieselEngine() {
    // === Diesel engine: low rumble + charkot ===

    // Base oscillator: sawtooth for diesel character
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = 45;
    nodes.push(osc1);

    // Sub oscillator: square for pulsing
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = 22;
    nodes.push(osc2);

    // Third harmonic
    const osc3 = ctx.createOscillator();
    osc3.type = 'sawtooth';
    osc3.frequency.value = 90;
    nodes.push(osc3);

    // Lowpass filter — muffles everything above cutoff
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 300;
    lowpass.Q.value = 1;
    nodes.push(lowpass);

    // LFO for charkot (gain modulation)
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5;
    nodes.push(lfo);

    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0;
    nodes.push(lfoGain);

    // Individual gains
    const osc1Gain = ctx.createGain();
    osc1Gain.gain.value = 0.25;
    nodes.push(osc1Gain);

    const osc2Gain = ctx.createGain();
    osc2Gain.gain.value = 0.12;
    nodes.push(osc2Gain);

    const osc3Gain = ctx.createGain();
    osc3Gain.gain.value = 0.08;
    nodes.push(osc3Gain);

    // Noise source for road/exhaust
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;
    nodes.push(noiseSource);

    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.04;
    nodes.push(noiseGain);

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = 400;
    nodes.push(noiseFilter);

    // Connect: oscs → gains → lowpass → master
    osc1.connect(osc1Gain);
    osc2.connect(osc2Gain);
    osc3.connect(osc3Gain);
    osc1Gain.connect(lowpass);
    osc2Gain.connect(lowpass);
    osc3Gain.connect(lowpass);

    // LFO → modulate osc1Gain
    lfo.connect(lfoGain);
    lfoGain.connect(osc1Gain.gain);

    // Noise → filter → gain → master
    noiseSource.connect(noiseFilter);
    noiseFilter.connect(noiseGain);

    lowpass.connect(masterGain);
    noiseGain.connect(masterGain);

    // Start all
    osc1.start();
    osc2.start();
    osc3.start();
    lfo.start();
    noiseSource.start();

    // Return update function
    return function update(rpm) {
      // RPM 0-1 maps to frequency range
      const baseFreq = 40 + rpm * 60;   // 40-100 Hz
      const subFreq = baseFreq / 2;
      const harmFreq = baseFreq * 2;

      osc1.frequency.setTargetAtTime(baseFreq, ctx.currentTime, 0.05);
      osc2.frequency.setTargetAtTime(subFreq, ctx.currentTime, 0.05);
      osc3.frequency.setTargetAtTime(harmFreq, ctx.currentTime, 0.05);

      // Filter opens up with RPM
      const cutoff = 200 + rpm * 800;
      lowpass.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.05);

      // LFO depth increases with RPM (more charkot at higher RPM)
      lfoGain.gain.setTargetAtTime(rpm * 0.08, ctx.currentTime, 0.05);
      lfo.frequency.setTargetAtTime(3 + rpm * 8, ctx.currentTime, 0.05);

      // Volume scales with RPM
      const vol = 0.15 + rpm * 0.35;
      osc1Gain.gain.setTargetAtTime(vol, ctx.currentTime, 0.05);
      osc2Gain.gain.setTargetAtTime(vol * 0.5, ctx.currentTime, 0.05);
      osc3Gain.gain.setTargetAtTime(vol * 0.3, ctx.currentTime, 0.05);

      // Noise gets louder with speed
      noiseGain.gain.setTargetAtTime(0.02 + rpm * 0.12, ctx.currentTime, 0.05);
      noiseFilter.frequency.setTargetAtTime(300 + rpm * 1200, ctx.currentTime, 0.05);
    };
  }

  function buildTramEngine() {
    // === Tram: electric whine + hum ===

    // Main whine oscillator
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = 250;
    nodes.push(osc1);

    // Second harmonic
    const osc2 = ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.value = 125;
    nodes.push(osc2);

    // High harmonic for electric character
    const osc3 = ctx.createOscillator();
    osc3.type = 'sine';
    osc3.frequency.value = 500;
    nodes.push(osc3);

    // Highpass filter — cuts bass, keeps electric character
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 100;
    highpass.Q.value = 0.5;
    nodes.push(highpass);

    // LFO for vibrato (frequency modulation)
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 1;
    nodes.push(lfo);

    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0;
    nodes.push(lfoGain);

    // Individual gains
    const osc1Gain = ctx.createGain();
    osc1Gain.gain.value = 0.12;
    nodes.push(osc1Gain);

    const osc2Gain = ctx.createGain();
    osc2Gain.gain.value = 0.08;
    nodes.push(osc2Gain);

    const osc3Gain = ctx.createGain();
    osc3Gain.gain.value = 0.04;
    nodes.push(osc3Gain);

    // Noise source for rail/wheel contact
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;
    nodes.push(noiseSource);

    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.02;
    nodes.push(noiseGain);

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 800;
    noiseFilter.Q.value = 0.5;
    nodes.push(noiseFilter);

    // Connect: oscs → gains → highpass → master
    osc1.connect(osc1Gain);
    osc2.connect(osc2Gain);
    osc3.connect(osc3Gain);
    osc1Gain.connect(highpass);
    osc2Gain.connect(highpass);
    osc3Gain.connect(highpass);

    // LFO → modulate osc1 frequency (vibrato)
    lfo.connect(lfoGain);
    lfoGain.connect(osc1.frequency);

    // Noise → filter → gain → master
    noiseSource.connect(noiseFilter);
    noiseFilter.connect(noiseGain);

    highpass.connect(masterGain);
    noiseGain.connect(masterGain);

    // Start all
    osc1.start();
    osc2.start();
    osc3.start();
    lfo.start();
    noiseSource.start();

    // Return update function
    return function update(rpm) {
      // RPM 0-1 maps to frequency range (higher than diesel)
      const baseFreq = 200 + rpm * 400;  // 200-600 Hz
      const harmFreq = baseFreq / 2;
      const highFreq = baseFreq * 2;

      osc1.frequency.setTargetAtTime(baseFreq, ctx.currentTime, 0.05);
      osc2.frequency.setTargetAtTime(harmFreq, ctx.currentTime, 0.05);
      osc3.frequency.setTargetAtTime(highFreq, ctx.currentTime, 0.05);

      // Highpass shifts down at idle, up at speed
      highpass.frequency.setTargetAtTime(80 + rpm * 200, ctx.currentTime, 0.05);

      // Vibrato depth and speed increase with RPM
      lfoGain.gain.setTargetAtTime(rpm * 15, ctx.currentTime, 0.05);
      lfo.frequency.setTargetAtTime(0.5 + rpm * 3, ctx.currentTime, 0.05);

      // Volume scales with RPM
      const vol = 0.08 + rpm * 0.2;
      osc1Gain.gain.setTargetAtTime(vol, ctx.currentTime, 0.05);
      osc2Gain.gain.setTargetAtTime(vol * 0.6, ctx.currentTime, 0.05);
      osc3Gain.gain.setTargetAtTime(vol * 0.3, ctx.currentTime, 0.05);

      // Rail noise increases with speed
      noiseGain.gain.setTargetAtTime(0.01 + rpm * 0.08, ctx.currentTime, 0.05);
      noiseFilter.frequency.setTargetAtTime(500 + rpm * 1500, ctx.currentTime, 0.05);
    };
  }

  function updateLoop() {
    if (!running) return;

    const now = performance.now();
    const dt = Math.min((now - lastUpdateTime) / 1000, 0.1); // seconds, capped
    lastUpdateTime = now;

    // Lerp currentRPM toward targetRPM
    const diff = targetRPM - currentRPM;
    if (Math.abs(diff) > 0.001) {
      currentRPM += diff * Math.min(LERP_SPEED * dt, 1);
    } else {
      currentRPM = targetRPM;
    }

    // Add slight randomness for organic feel
    const jitter = (Math.random() - 0.5) * 0.01;
    const effectiveRPM = Math.max(0, Math.min(1, currentRPM + jitter));

    // Update audio parameters
    if (updateFn) {
      updateFn(effectiveRPM);
    }

    // Master volume: fade in/out based on RPM (never fully silent when running)
    const masterVol = 0.4 + effectiveRPM * 0.6;
    masterGain.gain.setTargetAtTime(masterVol, ctx.currentTime, 0.05);

    animFrameId = requestAnimationFrame(updateLoop);
  }

  let updateFn = null;

  return {
    async start(engineType) {
      if (running) this.stop();

      type = engineType;
      ctx = new (window.AudioContext || window.webkitAudioContext)();

      // Resume if suspended (browser autoplay policy) — must await!
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      noiseBuffer = createNoiseBuffer(ctx);

      masterGain = ctx.createGain();
      masterGain.gain.value = 0;
      masterGain.connect(ctx.destination);

      if (type === 'tram') {
        updateFn = buildTramEngine();
      } else {
        updateFn = buildDieselEngine();
      }

      currentRPM = 0;
      targetRPM = 0;
      running = true;
      lastUpdateTime = performance.now();

      // Fade in master
      masterGain.gain.setTargetAtTime(0.5, ctx.currentTime, 0.1);

      animFrameId = requestAnimationFrame(updateLoop);
    },

    setRPM(rpm) {
      targetRPM = Math.max(0, Math.min(1, rpm));
    },

    stop() {
      running = false;

      if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }

      // Fade out then cleanup
      if (masterGain && ctx) {
        masterGain.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
      }

      // Delayed cleanup to let fade complete
      const oldCtx = ctx;
      const oldNodes = [...nodes];
      const oldMasterGain = masterGain;
      setTimeout(() => {
        oldNodes.forEach(n => {
          try { n.stop?.(); } catch (_) {}
          try { n.disconnect(); } catch (_) {}
        });
        try { oldMasterGain?.disconnect(); } catch (_) {}
        try { oldCtx?.close(); } catch (_) {}
      }, 300);

      ctx = null;
      masterGain = null;
      nodes = [];
      updateFn = null;
      currentRPM = 0;
      targetRPM = 0;
    },

    get isRunning() {
      return running;
    }
  };
}

export { createEngineSound };

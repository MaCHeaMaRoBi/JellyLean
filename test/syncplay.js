#!/usr/bin/env node
/* Regression test for the SyncPlay pause/resume feedback loop.
   Simulates the parts of Jellyfin's group state machine that matter:
     - Ready while the group is Paused/Playing is answered by re-sending the
       current Pause/Unpause to the sender ("client got lost").
     - Buffering while Paused/Playing moves the group to Waiting and pauses all.
   A well-behaved TV answers a Pause/Unpause with nothing at all.
     node test/syncplay.js                      test js/syncplay.js
     SYNCPLAY_JS=/path/old.js node test/syncplay.js
*/
'use strict';

var path = require('path');
var file = process.env.SYNCPLAY_JS || path.join(__dirname, '..', 'js', 'syncplay.js');

global.window = global;
global.U = {
    emitter: function (obj) {
        var h = {};
        obj.on = function (n, f) { (h[n] = h[n] || []).push(f); };
        obj.emit = function (n) {
            var a = Array.prototype.slice.call(arguments, 1);
            (h[n] || []).forEach(function (f) { f.apply(null, a); });
        };
        return obj;
    },
    msToTicks: function (ms) { return Math.round(ms * 10000); },
    ticksToMs: function (t) { return t / 10000; },
    clamp: function (v, a, b) { return Math.max(a, Math.min(b, v)); },
    toast: function () {}
};

var requests = { ready: 0, buffering: 0 };
var server = { state: 'Playing', last: null, position: 0 };
var socket = null;

function now() { return new Date().toISOString(); }
function push(msg) { setTimeout(function () { socket.onMessage(msg); }, 5); }
function command(name, positionMs) {
    server.last = { Command: name, PositionTicks: String(positionMs * 10000), When: now(), EmittedAt: now() };
    push({ MessageType: 'SyncPlayCommand', Data: server.last });
}

global.Api = {
    serverTime: function () { return Promise.resolve({ RequestReceptionTime: now(), ResponseTransmissionTime: now() }); },
    syncPlayPing: function () {},
    openSocket: function (h) { socket = h; return { close: function () {} }; },
    syncPlayReady: function () {
        requests.ready++;
        if (server.state === 'Waiting') { server.state = 'Playing'; command('Unpause', server.position); }
        else if (server.last) { push({ MessageType: 'SyncPlayCommand', Data: Object.assign({}, server.last, { EmittedAt: now() }) }); }
        return Promise.resolve();
    },
    syncPlayBuffering: function () {
        requests.buffering++;
        if (server.state !== 'Waiting') { server.state = 'Waiting'; command('Pause', server.position); }
        return Promise.resolve();
    }
};

/* AVPlay-like player: seekTo fires 'seeked' at once and a buffering cycle.
   While `sim.on`, getPosition follows a real clock plus controllable error. */
var pos = 10000, paused = false;
var sim = { on: false, base: 0, startedAt: 0, extra: 0, noise: 0, seeks: 0, speeds: 0 };
function simTrue() { return sim.base + (Date.now() - sim.startedAt); }
global.Player = {
    mode: 'avplay',
    getPosition: function () { return sim.on ? simTrue() + sim.extra + sim.noise : pos; },
    isPaused: function () { return paused; },
    pause: function () { paused = true; },
    resume: function () { paused = false; },
    setSpeed: function () { sim.speeds++; },
    seekTo: function (ms) {
        if (sim.on) { sim.seeks++; sim.extra = ms - simTrue(); }
        pos = ms;
        SyncPlay.onSeeked();
        SyncPlay.onBuffering(true);
        setTimeout(function () { SyncPlay.onBuffering(false); }, 20);
    }
};

require(file);
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function () {
    SyncPlay.connect();
    socket.onMessage({ MessageType: 'SyncPlayGroupUpdate',
        Data: { Type: 'GroupJoined', Data: { GroupId: 'g', LastUpdatedAt: '2000-01-01T00:00:00Z' } } });
    socket.onMessage({ MessageType: 'SyncPlayGroupUpdate',
        Data: { Type: 'StateUpdate', Data: { State: 'Playing', Reason: 'Unpause' } } });
    await wait(50);
    SyncPlay.setPlaybackActive(true);

    /* PC pauses at 12 s ... */
    server.state = 'Paused'; server.position = 12000;
    socket.onMessage({ MessageType: 'SyncPlayGroupUpdate', Data: { Type: 'StateUpdate', Data: { State: 'Paused', Reason: 'Pause' } } });
    command('Pause', 12000);
    /* Wait out the Pause quiet window so the Unpause rebuffer test below is
       not masked by it. */
    await wait(2600);
    var afterPause = { ready: requests.ready, buffering: requests.buffering };

    /* ... and resumes. */
    server.state = 'Playing';
    socket.onMessage({ MessageType: 'SyncPlayGroupUpdate', Data: { Type: 'StateUpdate', Data: { State: 'Playing', Reason: 'Unpause' } } });
    command('Unpause', 12000);
    await wait(800);

    var total = requests.ready + requests.buffering;
    console.log('after pause : ready=' + afterPause.ready + ' buffering=' + afterPause.buffering);
    console.log('after resume: ready=' + requests.ready + ' buffering=' + requests.buffering);
    console.log('TV ends ' + (paused ? 'PAUSED' : 'playing') + ' at ' + pos + ' ms');
    var loopFree = total === 0 && !paused;

    /* AVPlay rebuffers when HLS resumes. That stall must stay inside the quiet
       window too, or the group is told "Waiting" and re-sends the Unpause. */
    var bResume = requests.buffering;
    SyncPlay.onBuffering(true);
    SyncPlay.onBuffering(false);
    var resumeRebufferQuiet = requests.buffering === bResume;
    console.log('Rebuffer right after resume reported: ' + !resumeRebufferQuiet);

    /* The fix must not silence legitimate reports. A Seek command puts the
       group in Waiting and the TV has to acknowledge it with Ready ... */
    var r0 = requests.ready;
    server.state = 'Waiting'; server.position = 30000;
    socket.onMessage({ MessageType: 'SyncPlayGroupUpdate', Data: { Type: 'StateUpdate', Data: { State: 'Waiting', Reason: 'Seek' } } });
    command('Seek', 30000);
    await wait(1200);
    var seekAcked = requests.ready - r0 >= 1 && Math.abs(pos - 30000) < 400;
    console.log('Seek command acknowledged with Ready: ' + seekAcked);

    /* ... and a real stall, outside the window of our own seeks, is still
       reported so the group waits for the TV. */
    await wait(2600);
    var b0 = requests.buffering;
    /* A dip shorter than the debounce must never reach the group: telling it
       "waiting" pauses every device, which is the stutter users see. */
    SyncPlay.onBuffering(true);
    await wait(1500);
    SyncPlay.onBuffering(false);
    await wait(1800);
    var microStallQuiet = requests.buffering === b0;
    console.log('1.5 s micro-stall reported: ' + !microStallQuiet);

    var r1 = requests.ready;
    SyncPlay.onBuffering(true);
    await wait(3300);
    var stallReported = requests.buffering - b0 === 1;
    SyncPlay.onBuffering(false);
    var stallReady = requests.ready - r1 === 1;
    console.log('Genuine 3 s+ stall reported: ' + stallReported +
        ', Ready on recovery: ' + stallReady);

    /* Drift correction. A TV in sync whose position readings are noisy
       (+-450 ms, as sampled every 500 ms) must not be seeked or re-speeded:
       each seek rebuffers and each speed change glitches, i.e. stutters. */
    async function startGroupPlayback() {
        server.state = 'Playing'; server.position = 40000;
        socket.onMessage({ MessageType: 'SyncPlayGroupUpdate', Data: { Type: 'StateUpdate', Data: { State: 'Playing', Reason: 'Unpause' } } });
        sim.on = true; sim.base = 40000; sim.startedAt = Date.now(); sim.extra = 0; sim.noise = 0;
        command('Unpause', 40000);
        await wait(1700); /* handled, and drift correction armed */
        sim.seeks = 0; sim.speeds = 0;
    }
    async function ticks(n, noiseAmp) {
        for (var i = 0; i < n; i++) {
            sim.noise = Math.round(noiseAmp * Math.sin(i * 2.3 + 1));
            SyncPlay.syncTick(Player.getPosition());
            await wait(520);
        }
        sim.noise = 0;
    }

    await startGroupPlayback();
    await ticks(10, 450);
    var noiseSeeks = sim.seeks, noiseSpeeds = sim.speeds;
    var steady = noiseSeeks === 0 && noiseSpeeds === 0;
    console.log('In-sync TV, noisy readings: seeks=' + noiseSeeks + ' speed changes=' + noiseSpeeds + (steady ? '' : '  <- stutter'));

    /* A genuine desync still gets corrected, once, without ping-pong. */
    await startGroupPlayback();
    sim.extra = -2500; /* TV is 2.5 s behind the group */
    await ticks(12, 0);
    var corrected = sim.seeks === 1 && Math.abs(Player.getPosition() - simTrue()) < 400;
    console.log('Real 2.5 s desync: seeks=' + sim.seeks + ' (want 1), residual ' +
        Math.round(simTrue() - Player.getPosition()) + ' ms');

    /* Leaving the group must cancel a command already waiting for its When. */
    paused = false;
    socket.onMessage({ MessageType: 'SyncPlayCommand', Data: {
        Command: 'Pause', PositionTicks: String(50000 * 10000),
        When: new Date(Date.now() + 1500).toISOString(), EmittedAt: now()
    } });
    SyncPlay.disconnect();
    await wait(2200);
    var disconnectClear = paused === false;
    console.log('Scheduled command cancelled on disconnect: ' + disconnectClear);

    var ok = loopFree && resumeRebufferQuiet && seekAcked && microStallQuiet &&
        stallReported && stallReady && steady && corrected && disconnectClear;
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
})();

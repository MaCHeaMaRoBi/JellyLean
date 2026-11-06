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

/* AVPlay-like player: seekTo fires 'seeked' at once and a buffering cycle. */
var pos = 10000, paused = false;
global.Player = {
    getPosition: function () { return pos; },
    isPaused: function () { return paused; },
    pause: function () { paused = true; },
    resume: function () { paused = false; },
    setSpeed: function () {},
    seekTo: function (ms) {
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
    await wait(800);
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
    SyncPlay.onBuffering(true);
    var stallReported = requests.buffering - b0 === 1;
    console.log('Genuine buffering reported: ' + stallReported);

    var ok = loopFree && seekAcked && stallReported;
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
})();

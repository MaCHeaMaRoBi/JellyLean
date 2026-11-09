#!/usr/bin/env node
/* OSD regression test. Needs jsdom (npm i jsdom); skipped when it is absent.
   Checks that nothing pins the player OSD: it must fade after a few idle
   seconds even with the playback-info panel open or a control focused.
     node test/osd.js
     PLAYER_JS=/path/old-player-screen.js node test/osd.js   (compare versions)  */
'use strict';

var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');
var JSDOM;
try { JSDOM = require('jsdom').JSDOM; } catch (e) {
    try { JSDOM = require(path.join(process.env.JSDOM_DIR || '/tmp/jd', 'node_modules', 'jsdom')).JSDOM; }
    catch (e2) { console.log('osd test skipped: jsdom not installed'); process.exit(0); }
}

var html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
var dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
var w = dom.window;

/* A controllable clock so "5 seconds later" takes no time. */
var now = 0, nextId = 1, timers = [];
w.setTimeout = function (fn, ms) { var id = nextId++; timers.push({ id: id, fn: fn, at: now + (ms || 0) }); return id; };
w.clearTimeout = function (id) { timers = timers.filter(function (t) { return t.id !== id; }); };
w.setInterval = function () { return nextId++; };
w.clearInterval = function () {};
function advance(ms) {
    var end = now + ms;
    for (;;) {
        var due = timers.filter(function (t) { return t.at <= end; })
            .sort(function (a, b) { return a.at - b.at; })[0];
        if (!due) break;
        timers = timers.filter(function (t) { return t !== due; });
        now = due.at;
        due.fn();
    }
    now = end;
}

['js/util.js', 'js/store.js', 'js/api.js', 'js/icons.js', 'js/ui.js', 'js/player.js',
 'js/subtitles.js', 'js/audio.js', 'js/skipintro.js', 'js/syncplay.js',
 'js/screens/player-audio.js'].forEach(function (f) {
    w.eval(fs.readFileSync(path.join(root, f), 'utf8'));
});
w.eval(fs.readFileSync(process.env.PLAYER_JS || path.join(root, 'js/screens/player-screen.js'), 'utf8'));

w.App = { back: function () {}, exitApp: function () {}, playItem: function () { return Promise.resolve(); } };
w.Player.open = function () {};
w.Player.pause = function () {};
w.Player.resume = function () {};
w.Player.seekTo = function () {};
w.Api.reportStart = w.Api.reportProgress = w.Api.reportStopped = function () { return Promise.resolve(); };
w.SkipIntro.load = function () {};

var item = { Id: 'i1', Type: 'Movie', Name: 'Test' };
w.Screens.player.render(w.document.body, {
    item: item, url: 'http://x/stream', playMethod: 'DirectPlay', startMs: 0,
    source: { Id: 's', Container: 'mkv', MediaStreams: [] }
});

var osd = w.document.getElementById('osd');
var info = w.document.getElementById('playbackInfo');
function key(code) {
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { keyCode: code, which: code, bubbles: true, cancelable: true }));
}
function faded() { return osd.classList.contains('faded'); }
function inOsd() { var a = w.document.activeElement; return !!a && osd.contains(a); }

var failures = 0;
function check(name, ok) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failures++; }

/* 1. idle OSD fades */
check('visible right after opening', !faded());
advance(5200);
check('fades after idle', faded());

/* 2. info panel must not pin the OSD */
key(457); /* INFO */
check('INFO shows the playback info', !info.classList.contains('hidden') && !faded());
advance(5200);
check('info panel still readable after 5 s', !info.classList.contains('hidden') && !faded());
advance(5000);
check('OSD and info panel both gone after the info delay', faded() && info.classList.contains('hidden'));

/* 3. a focused control must not pin the OSD */
key(38); /* UP -> focus controls */
check('UP focuses a control', inOsd() && !faded());
advance(5200);
check('OSD fades even with a control focused', faded());
check('focus leaves the hidden controls', !inOsd());

console.log(failures ? 'FAIL' : 'PASS');
process.exit(failures ? 1 : 0);

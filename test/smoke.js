#!/usr/bin/env node
/* Zero-dependency browser smoke test.
   Starts the dev server and headless Chromium, drives the real UI over the
   Chrome DevTools Protocol, and fails on any console error.
     node test/smoke.js
   Override the browser with CHROME=/path/to/chromium. */
'use strict';

var spawn = require('child_process').spawn;
var execFileSync = require('child_process').execFileSync;
var fs = require('fs');
var os = require('os');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var PORT = Number(process.env.PORT || 8096);
var CDP_PORT = Number(process.env.CDP_PORT || 9333);
var APP_URL = 'http://localhost:' + PORT + '/';

/* ------------------------------------------------------------- utilities */

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function findChrome() {
    if (process.env.CHROME) return process.env.CHROME;

    var candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
        '/snap/bin/chromium'];

    for (var i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) return candidates[i];
    }

    try {
        return execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim();
    } catch (e) {
        throw new Error('Chromium not found. Set CHROME=/path/to/chromium');
    }
}

async function waitForHttp(url, timeout) {
    var started = Date.now();
    while (Date.now() - started < (timeout || 20000)) {
        try {
            var response = await fetch(url);
            if (response.ok) return true;
        } catch (e) { /* not up yet */ }
        await sleep(150);
    }
    throw new Error('Timed out waiting for ' + url);
}

/* --------------------------------------------------------------- CDP glue */

function CDP(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = {};
    this.handlers = {};
}

CDP.prototype.open = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
        self.ws = new WebSocket(self.url);
        self.ws.onopen = function () { resolve(); };
        self.ws.onerror = function () { reject(new Error('Could not open the DevTools socket')); };
        self.ws.onmessage = function (event) {
            var message = JSON.parse(event.data);

            if (message.id) {
                var pending = self.pending[message.id];
                if (!pending) return;
                delete self.pending[message.id];
                if (message.error) pending.reject(new Error(message.error.message));
                else pending.resolve(message.result);
                return;
            }

            var handler = self.handlers[message.method];
            if (handler) handler(message.params);
        };
    });
};

CDP.prototype.send = function (method, params) {
    var self = this;
    var id = ++this.nextId;

    return new Promise(function (resolve, reject) {
        self.pending[id] = { resolve: resolve, reject: reject };
        self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
};

CDP.prototype.on = function (method, handler) {
    this.handlers[method] = handler;
};

/* ------------------------------------------------------------------- test */

async function main() {
    var chromePath = findChrome();
    var profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jflean-smoke-'));
    var server = null;
    var chrome = null;

    var checks = [];
    function check(name, condition, detail) {
        if (!condition) throw new Error('CHECK FAILED: ' + name + (detail ? ' — ' + detail : ''));
        checks.push(name);
        console.log('  ok  ' + name);
    }

    try {
        console.log('==> dev server');
        server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-server.js')], {
            cwd: ROOT,
            env: Object.assign({}, process.env, { QUIET: '1' }),
            stdio: ['ignore', 'pipe', 'pipe']
        });
        var serverErr = '';
        server.stderr.on('data', function (chunk) { serverErr += chunk; });
        await waitForHttp('http://127.0.0.1:' + PORT + '/System/Info/Public');

        console.log('==> chromium');
        chrome = spawn(chromePath, [
            '--headless=new',
            '--remote-debugging-port=' + CDP_PORT,
            '--user-data-dir=' + profile,
            '--no-first-run',
            '--no-default-browser-check',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--autoplay-policy=no-user-gesture-required',
            '--mute-audio',
            '--window-size=1920,1080',
            'about:blank'
        ], { stdio: 'ignore' });

        await waitForHttp('http://127.0.0.1:' + CDP_PORT + '/json/version');

        var targetResponse = await fetch(
            'http://127.0.0.1:' + CDP_PORT + '/json/new?' + encodeURIComponent('about:blank'),
            { method: 'PUT' }
        );
        var target = await targetResponse.json();

        var cdp = new CDP(target.webSocketDebuggerUrl);
        await cdp.open();

        var shotsDir = process.env.SHOTS ? path.join(ROOT, '.dev', 'screenshots') : null;

        async function capture(name) {
            if (!shotsDir) return;
            /* Let the 220ms screen-in fade finish so review shots show the
               settled palette instead of a half-opacity frame. */
            await sleep(260);
            if (!fs.existsSync(shotsDir)) fs.mkdirSync(shotsDir, { recursive: true });
            var shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(shotsDir, name + '.png'), Buffer.from(shot.data, 'base64'));
        }

        var errors = [];
        var expect401 = false;
        cdp.on('Runtime.exceptionThrown', function (params) {
            var details = params.exceptionDetails || {};
            errors.push('exception: ' + (details.exception && details.exception.description || details.text));
        });
        cdp.on('Runtime.consoleAPICalled', function (params) {
            if (params.type !== 'error') return;
            var text = (params.args || []).map(function (arg) {
                return arg.value !== undefined ? String(arg.value) : (arg.description || arg.type);
            }).join(' ');
            errors.push('console.error: ' + text);
        });
        cdp.on('Log.entryAdded', function (params) {
            var entry = params.entry || {};
            if (entry.level !== 'error') return;
            if (/favicon\.ico/.test(entry.url || '')) return;
            /* TMDB artwork needs the public internet; a sandbox without it is
               not an app failure (the cards fall back to placeholders). */
            if (/image\.tmdb\.org/.test(entry.url || '') && /ERR_(TUNNEL|NAME|INTERNET|CONNECTION)/.test(entry.text || '')) return;
            /* The 401 check deliberately asks the server for one. */
            if (expect401 && /\b401\b/.test(entry.text || '')) return;
            errors.push('log: ' + entry.text + (entry.url ? ' (' + entry.url + ')' : ''));
        });


        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Log.enable');
        
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false
        });

        async function evaluate(expression) {
            var result = await cdp.send('Runtime.evaluate', {
                expression: expression,
                returnByValue: true,
                awaitPromise: true
            });
            if (result.exceptionDetails) {
                var details = result.exceptionDetails;
                throw new Error('evaluate failed: ' +
                    (details.exception && details.exception.description || details.text));
            }
            return result.result.value;
        }

        async function press(key, keyCode) {
            var event = {
                key: key,
                code: key,
                windowsVirtualKeyCode: keyCode,
                nativeVirtualKeyCode: keyCode
            };
            await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, event));
            await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, event));
        }

        async function waitFor(expression, label, timeout) {
            var started = Date.now();
            while (Date.now() - started < (timeout || 20000)) {
                try {
                    if (await evaluate(expression)) return true;
                } catch (e) { /* page may be mid-navigation */ }
                await sleep(150);
            }
            var snapshot = '';
            try {
                snapshot = await evaluate("location.href + '\\n' + document.body.innerText.slice(0, 600) + '\\n' + localStorage.getItem('jellyfinLean.config.v1')");
            } catch (e) { /* ignore */ }
            throw new Error('Timed out waiting for ' + label + '\n--- page ---\n' + snapshot +
                (errors.length ? '\n--- errors ---\n' + errors.join('\n') : ''));
        }

        console.log('==> navigating');
        await cdp.send('Page.navigate', { url: APP_URL });

        await waitFor("!!document.querySelector('#serverUrl')", 'setup screen');
        check('setup screen renders', true);
        await capture('01-setup');

        /* The TV's on-screen keyboard opens on focus, so a field stays readonly
           until OK is pressed on it: moving through the form must not pop it up. */
        await waitFor("document.activeElement && document.activeElement.id === 'serverUrl'",
            'server field focus');
        check('the focused server field is readonly',
            (await evaluate("document.querySelector('#serverUrl').readOnly")) === true);
        check('the keyboard layout stays away until editing',
            (await evaluate("document.querySelector('.screen.setup').classList.contains('typing')")) === false);
        await press('ArrowRight', 39);
        await press('ArrowLeft', 37);
        check('left/right leave the field navigable',
            (await evaluate("document.querySelector('#serverUrl').readOnly &&" +
                " document.activeElement.id === 'serverUrl'")) === true);
        await press('Enter', 13);
        await sleep(120);
        check('OK on the field starts editing',
            (await evaluate("var i=document.querySelector('#serverUrl');" +
                " i.readOnly === false && document.activeElement === i")) === true);
        check('editing raises the keyboard layout',
            (await evaluate("document.querySelector('.screen.setup').classList.contains('typing')")) === true);
        await evaluate("document.querySelector('#serverUrl').value=''; true");
        await press('ArrowDown', 40);
        await sleep(120);
        check('down from the field focuses Connect',
            (await evaluate("document.activeElement.id")) === 'connectBtn');
        check('leaving the field makes it readonly again',
            (await evaluate("document.querySelector('#serverUrl').readOnly")) === true);
        check('the keyboard layout drops with the field',
            (await evaluate("document.querySelector('.screen.setup').classList.contains('typing')")) === false);

        check('setup actions carry icons',
            (await evaluate("document.querySelectorAll('#connectBtn svg.icon').length")) === 1);
        await press('ArrowUp', 38);
        check('up returns to the field',
            (await evaluate("document.activeElement.id")) === 'serverUrl');

        await evaluate("document.querySelector('#serverUrl').value='localhost:" + PORT + "'; true");
        /* Enter in edit mode still connects, as it always did. */
        await press('Enter', 13);
        await sleep(120);
        await press('Enter', 13);

        await waitFor("!!document.querySelector('#username')", 'login step');
        check('server probe moves to login', true);
        /* The screen focuses the first field after render; pressing before that
           would send Down to whatever still owned focus. */
        await waitFor("document.activeElement && document.activeElement.id === 'username'",
            'username focus');
        check('the username field arrives readonly',
            (await evaluate("document.querySelector('#username').readOnly")) === true);

        await press('ArrowDown', 40);
        check('down moves username to password',
            (await evaluate("document.activeElement.id")) === 'password');
        await press('ArrowDown', 40);
        check('down from password reaches Sign in',
            (await evaluate("document.activeElement.id")) === 'loginBtn');
        await press('ArrowRight', 39);
        check('right reaches Quick Connect',
            (await evaluate("document.activeElement.id")) === 'quickBtn');

        /* Enter in edit mode on a middle field closes the keyboard and moves
           on: the next field arrives navigable, so no keyboard pops up. */
        await press('ArrowLeft', 39);
        await press('ArrowUp', 38);
        await press('ArrowUp', 38);
        check('up walks back to the username field',
            (await evaluate("document.activeElement.id")) === 'username');
        await press('Enter', 13);
        await sleep(120);
        check('OK on username starts editing',
            (await evaluate("document.querySelector('#username').readOnly")) === false);
        await press('Enter', 13);
        await sleep(120);
        check('Enter on username moves to password without a keyboard',
            (await evaluate("document.activeElement.id === 'password' &&" +
                " document.querySelector('#password').readOnly &&" +
                " document.querySelector('#username').readOnly")) === true);

        /* Discover talks to Seerr directly: the dev server serves a mock of it
           under /seerr, and the address and key come from Settings. Configured
           before the sign-in to exercise the pre-login prefs adoption. */
        await evaluate("Seerr.configure(location.origin + '/seerr', 'dev-key'); true");

        await evaluate("document.querySelector('#username').value='dev';" +
            "document.querySelector('#password').value='dev';" +
            " document.querySelector('#loginBtn').click(); true");

        await waitFor("document.querySelectorAll('.row .card').length > 0", 'home rows');
        var rowTitles = await evaluate(
            "Array.prototype.map.call(document.querySelectorAll('.row-title'), function (n) { return n.textContent; })"
        );
        check('home shows library, continue and next-up rows',
            rowTitles.indexOf('Next Up') !== -1 && rowTitles.join(',').indexOf('Latest in') !== -1,
            rowTitles.join(', '));
        await waitFor("Array.prototype.some.call(document.querySelectorAll('.nav .tab')," +
            " function (b) { return b.textContent.indexOf('Discover') !== -1; })",
            'discover nav tab');
        check('nav lists libraries as tabs',
            await evaluate("Array.prototype.some.call(document.querySelectorAll('.nav .tab')," +
                " function (b) { return b.textContent.indexOf('Movies') !== -1; })"));
        check('home exposes Discover when Seerr answers', true);
        await capture('02-home');

        /* Artwork must ask the server for the size the card draws, not the
           original poster: a 2000 px JPEG per card is what fills the TV's
           memory on a long row. */
        var art = await evaluate(
            "Array.prototype.map.call(document.querySelectorAll('img')," +
            " function (i) { return i.getAttribute('src') || i.getAttribute('data-src'); })" +
            ".filter(function (s) { return /\\/Images\\//.test(s || ''); })");
        var unsized = art.filter(function (src) { return !/[?&]maxWidth=\d+/.test(src); });
        var widest = art.reduce(function (max, src) {
            var m = /[?&]maxWidth=(\d+)/.exec(src);
            return m ? Math.max(max, Number(m[1])) : max;
        }, 0);
        check('every card image asks for a sized render', art.length > 0 && unsized.length === 0,
            unsized.length + ' of ' + art.length + ' unsized: ' + unsized.slice(0, 3).join(' | '));
        check('no card image asks for more than 1600 px', widest <= 1600, widest + ' px');

        /* The hero only appears when something is resumable, and the mock
           catalogue has no history. Stub one item in to exercise that path. */
        await evaluate(
            "window.__origResume = Api.resume;" +
            "Api.resume = function () { return Promise.resolve([{" +
            " Id: 'resume-1', Name: 'Resum\u00e9 Test', Type: 'Movie'," +
            " ProductionYear: 2024, RunTimeTicks: 6000000000, OfficialRating: 'PG-13'," +
            " CommunityRating: 8.1, Genres: ['Drama']," +
            " UserData: { PlaybackPositionTicks: 1200000000 } }]); };" +
            "App.go('home'); true");
        await waitFor("!!document.querySelector('.stage-info .btn')", 'home stage');
        await waitFor("document.activeElement && document.activeElement.classList.contains('btn')", 'hero focus');
        check('a resumable item gets the hero and first focus', true);
        await sleep(320);
        await capture('02b-home-hero');

        await evaluate("Api.resume = window.__origResume; App.go('home'); true");
        await waitFor("document.querySelectorAll('.row .card').length > 0", 'home restored');

        await evaluate("App.go('syncplay'); true");
        await waitFor("(document.querySelector('h1.title') || {}).textContent === 'SyncPlay'", 'syncplay screen');
        await waitFor("document.body.innerText.indexOf('No open groups') !== -1", 'empty group list');
        check('syncplay screen lists groups', true);
        await capture('03-syncplay');

        await press('Enter', 13);
        await waitFor("document.querySelector('.badge-live')", 'group active');
        check('creating a group enables SyncPlay', await evaluate("SyncPlay.isEnabled()"), 'enabled');
        await capture('03b-syncplay-active');

        await evaluate(
            "Array.prototype.filter.call(document.querySelectorAll('.btn')," +
            " function (b) { return b.textContent === 'Leave Group'; })[0].click(); true"
        );
        await waitFor("document.body.innerText.indexOf('No open groups') !== -1", 'group left');
        check('leaving a group disables SyncPlay', await evaluate("!SyncPlay.isEnabled()"), 'disabled');

        await evaluate("App.go('home'); true");
        await waitFor("document.querySelectorAll('.row .card').length > 0", 'home again');

        await waitFor("document.activeElement && document.activeElement.classList.contains('btn')", 'home focus');
        check('the stage action owns focus on home', true);
        await press('ArrowUp', 38);
        check('up from the stage enters the nav at Home',
            (await evaluate("document.activeElement.textContent")) === 'Home');
        await press('ArrowRight', 39);
        check('right moves along the tabs',
            (await evaluate("document.activeElement.textContent")) === 'Movies');
        await press('Enter', 13);

        await waitFor("document.querySelectorAll('.grid .card').length > 0", 'library grid');
        check('OK on a tab opens the library', true);
        await capture('04-library');

        /* Entering a library lands on the first poster; sort is one Up away. */
        await waitFor("document.activeElement && document.activeElement.classList.contains('card')",
            'library focus');
        check('library focuses the first poster', true);
        await press('ArrowUp', 38);
        check('up from the grid reaches the sort control',
            /Sort: Name/.test(await evaluate("document.activeElement.textContent")));

        await press('Enter', 13);
        await press('Enter', 13);
        await waitFor("(Store.get('librarySort:lib-movies') || {}).sortBy === 'CommunityRating'",
            'sort persisted');
        check('OK cycles the sort and persists it for the library', true);

        await press('ArrowRight', 39);
        await press('Enter', 13);
        await waitFor("(Store.get('librarySort:lib-movies') || {}).sortOrder === 'Descending'",
            'direction persisted');
        check('direction toggles and persists',
            /High to low/.test(await evaluate("document.activeElement.textContent")));

        await waitFor("document.querySelectorAll('.grid .card').length > 0", 'grid after sort');
        await press('ArrowDown', 40);
        await waitFor("document.activeElement && document.activeElement.classList.contains('card')",
            'grid focus');
        check('down from the sort controls reaches the grid', true);
        await press('Enter', 13);

        await waitFor("(document.querySelector('.cinema-hero h1') || {}).getAttribute && document.querySelector('.cinema-hero h1').getAttribute('aria-label') === 'Big Buck Bunny'", 'movie detail');
        check('detail screen renders', true);
        await capture('05-detail');

        await waitFor("document.activeElement && /btn/.test(document.activeElement.className)", 'play focus');
        check('play button owns focus', true);

        check('detail play button carries an icon',
            (await evaluate("document.querySelectorAll('.cinema-hero .btn.primary svg.icon').length")) === 1);

        /* Selecting a movie must say what it is: synopsis, cast, crew and the
           technical facts of the file behind the poster. */
        check('detail shows a synopsis',
            (await evaluate("(document.querySelector('.cinema-hero .overview') || {}).textContent || ''"))
                .length > 20);
        check('detail lists genres',
            (await evaluate("(document.querySelector('.cinema-hero .meta .genres') || {}).textContent || ''")).indexOf(',') !== -1);
        check('detail lists the studio in its facts',
            /Blender Foundation/.test(await evaluate("document.querySelector('.facts').textContent")));
        check('detail marks the certification',
            (await evaluate("(document.querySelector('.cinema-hero .meta .cert') || {}).textContent")) === 'PG');
        check('detail names the director',
            /Sacha/.test(await evaluate("document.querySelector('.facts').textContent")));
        check('detail shows cast tiles with names',
            (await evaluate("document.querySelectorAll('.people .person').length")) >= 3 &&
            /Big Buck Bunny/.test(await evaluate("(document.querySelector('.person .caption') || {}).textContent || ''")));
        check('detail shows technical facts',
            /1920/.test(await evaluate("document.querySelector('.facts').textContent")) &&
            /AAC/.test(await evaluate("document.querySelector('.facts').textContent")));

        /* Phase D: watched and favourite state can be corrected from detail
           without opening the web dashboard. */
        function detailButton(label) {
            return "Array.prototype.filter.call(document.querySelectorAll('.cinema-hero .btn-row .btn')," +
                " function (b) { return b.textContent === '" + label + "'; })[0]";
        }
        check('detail offers watched and favourite actions',
            (await evaluate(detailButton('Mark Watched') + " !== undefined")) &&
            (await evaluate(detailButton('Favorite') + " !== undefined")));

        await evaluate(detailButton('Mark Watched') + ".click(); true");
        await waitFor(detailButton('Watched') + " !== undefined", 'watched painted');
        check('detail can mark an item watched', true);
        await evaluate(detailButton('Watched') + ".click(); true");
        await waitFor(detailButton('Mark Watched') + " !== undefined", 'unwatched painted');

        await evaluate(detailButton('Favorite') + ".click(); true");
        await waitFor(detailButton('Favorited') + " !== undefined", 'favourite painted');
        check('detail can favourite an item', true);
        await evaluate(detailButton('Favorited') + ".click(); true");
        await waitFor(detailButton('Favorite') + " !== undefined", 'favourite cleared');

        await waitFor("!!document.querySelector('.row .card') && document.body.innerText.indexOf('More Like This') !== -1",
            'similar titles row');
        check('detail suggests similar titles', true);

        await evaluate("U.focusNode(document.querySelector('.facts')); true");
        await sleep(400);
        await capture('05b-detail-lower');
        await evaluate("U.focusNode(document.querySelector('.cinema-hero .btn.primary')); true");
        await sleep(300);
        /* The TV's AVPlay path must not have an opaque element over its plane. */
        var fallbackHidden = await evaluate(
            "getComputedStyle(document.querySelector('#html5Video')).display === 'none'");
        check('fallback video stays hidden until used', fallbackHidden);

        await press('Enter', 13);

        await waitFor("!document.querySelector('#stage').classList.contains('hidden')", 'stage visible');

        /* Regression guard: AVPlay paints under the page, so an opaque stage or
           a stray <video> rectangle hides the picture while audio keeps going. */
        var stageBg = await evaluate("getComputedStyle(document.querySelector('#stage')).backgroundColor");
        check('stage stays transparent for AVPlay', stageBg === 'rgba(0, 0, 0, 0)', stageBg);

        /* <html> background propagates to the canvas, so body alone is not
           enough: the class has to clear the canvas too. */
        await evaluate("document.documentElement.classList.add('playing'); true");
        var canvasBg = await evaluate("getComputedStyle(document.documentElement).backgroundColor");
        await evaluate("document.documentElement.classList.remove('playing'); true");
        check('html canvas goes transparent for AVPlay', canvasBg === 'rgba(0, 0, 0, 0)', canvasBg);

        await waitFor("window.Player && Player.isOpen()", 'player open');
        await waitFor("Player.getPosition() > 300", 'position advancing');
        check('playback opens and advances', true);

        /* AVPlay swallows its own PAUSED/PLAYING events once the flag is set,
           so Player announces both itself. The OSD label hangs off them, and
           the pause report is what the server sees when the TV goes to HOME. */
        await evaluate("Player.pause(); true");
        var pausedLabel = await evaluate("document.querySelector('#ctlState').textContent");
        check('pause updates the osd state', pausedLabel === 'Paused', pausedLabel);
        await evaluate("Player.resume(); true");
        await waitFor("document.querySelector('#ctlState').textContent === 'Playing'", 'osd back to playing');
        check('resume updates the osd state', true);

        /* Direct play keeps the forced/default subtitle out of the video, so the
           client has to draw it from the WebVTT track itself. */
        await waitFor("(document.querySelector('#subtitleLayer') || {}).textContent === 'Mock subtitle line'",
            'subtitle cue');
        check('default subtitle is drawn over direct play', true);

        var fallbackShown = await evaluate(
            "getComputedStyle(document.querySelector('#html5Video')).display !== 'none'");
        check('html5 engine reveals its video element', fallbackShown);

        var osdTitle = await evaluate("document.querySelector('#osdTitle').textContent");
        check('osd shows the item title', /Big Buck Bunny/.test(osdTitle), osdTitle);

        await waitFor("!document.querySelector('#skipBar').classList.contains('hidden')", 'skip intro button');
        check('skip intro marker detected', true);
        await capture('06-player');

        await evaluate("document.querySelector('#skipBtn').click(); true");
        await waitFor("Player.getPosition() > 5500", 'seek past the intro');
        check('skip intro seeks past the segment', true);

        await waitFor("(document.querySelector('#subtitleLayer') || {}).textContent === 'Second mock line'",
            'subtitle after seek');
        check('subtitles follow a seek', true);

        var total = await evaluate("document.querySelector('#timeTotal').textContent");
        check('duration is displayed', total !== '0:00', total);

        /* ------------------------------------------------ osd control row */

        var controls = await evaluate(
            "document.querySelectorAll('#osdButtons .osd-btn').length + '|' +" +
            "document.querySelectorAll('#osdButtons .osd-btn svg.icon').length");
        check('osd has six icon controls', controls === '6|6', controls);

        /* Move just past the mock intro (2-6s) so UP lands on the control row,
           not Skip. Stay inside the 20s sample: seeking beyond the end would
           finish playback and close the screen mid-test. */
        await evaluate("Player.seekTo(7000); true");
        await waitFor("document.querySelector('#skipBar').classList.contains('hidden')", 'skip bar hidden');

        await press('ArrowUp', 38);
        await waitFor("document.activeElement.classList.contains('osd-btn-play')", 'play control focused');
        check('up focuses the control row', true);

        await press('ArrowRight', 39);
        await waitFor("document.activeElement.classList.contains('osd-btn-forward')", 'forward focused');
        await press('ArrowRight', 39);
        await waitFor("document.activeElement.classList.contains('osd-btn-audio')", 'audio control focused');
        await press('ArrowRight', 39);
        await waitFor("document.activeElement.classList.contains('osd-btn-subtitles')", 'subtitle control focused');
        await press('ArrowRight', 39);
        await waitFor("document.activeElement.classList.contains('osd-btn-info')", 'info focused');
        check('left/right move between controls', true);

        /* Subtitles must clear the control row while the OSD is up, or the
           buttons sit on top of the dialogue. */
        var clear = await evaluate(
            "(function () {" +
            " var b = document.querySelector('#osdButtons').getBoundingClientRect();" +
            " var s = document.querySelector('#subtitleLayer').getBoundingClientRect();" +
            " return s.bottom <= b.top + 0.5 ? 'clear' : (s.bottom + '>' + b.top);" +
            "})()");
        check('subtitles lift clear of the control row', clear === 'clear', clear);

        await capture('06d-controls');

        await press('Enter', 13);
        await waitFor("!document.querySelector('#playbackInfo').classList.contains('hidden')", 'info panel open');
        var infoText = await evaluate("document.querySelector('#playbackInfo').textContent");
        check('playback info panel lists the stream',
            /Direct play/.test(infoText) && /HTML5/.test(infoText) && /Container/.test(infoText), infoText);
        check('playback info shows stream type, size and source detail',
            /Stream type/.test(infoText) && /Direct play \(http\)/.test(infoText) &&
            /Video size/.test(infoText) && /640\u00d7360/.test(infoText) &&
            /Video attributes/.test(infoText) && /High, Lv 41, 1\.8 Mbps, 24\.00 fps/.test(infoText) &&
            /8 Bit, yuv420p/.test(infoText) &&
            /bt709\(m\), bt709\(p\), bt709\(t\)/.test(infoText), infoText);
        await capture('06e-info-panel');

        await press('Unidentified', 10009);
        await waitFor("document.querySelector('#playbackInfo').classList.contains('hidden')", 'info closed by BACK');
        check('BACK closes the info panel without leaving playback', await evaluate("Player.isOpen()"));

        await press('Info', 457);
        await waitFor("!document.querySelector('#playbackInfo').classList.contains('hidden')", 'info via remote key');
        await press('Info', 457);
        await waitFor("document.querySelector('#playbackInfo').classList.contains('hidden')", 'info toggled off');
        check('the remote INFO key toggles the panel', true);

        /* ------------------------------------------------ subtitle picker */

        await press('ArrowUp', 38);
        await waitFor("document.activeElement.classList.contains('osd-btn-play')", 'play refocused');
        await press('ArrowRight', 39);
        await press('ArrowRight', 39);
        await press('ArrowRight', 39);
        await waitFor("document.activeElement.classList.contains('osd-btn-subtitles')", 'subtitle control focused');
        await press('Enter', 13);
        await waitFor("!document.querySelector('#subtitlePanel').classList.contains('hidden')", 'subtitle picker open');
        check('subtitle picker opens from the control row', true);
        await capture('06f-subtitle-picker');

        var subtitleRows = await evaluate("document.querySelectorAll('#subtitleList .sub-row').length");
        check('picker lists Off and every track', subtitleRows === 4, String(subtitleRows));

        var activeSubtitle = await evaluate(
            "(document.querySelector('#subtitleList .sub-row.selected .sub-name') || {}).textContent");
        check('the current default track is marked', activeSubtitle === 'Romanian', activeSubtitle);

        await press('ArrowDown', 40);
        var nextSubtitle = await evaluate(
            "(document.activeElement.querySelector('.sub-name') || {}).textContent");
        check('down moves through the track list', nextSubtitle === 'English', nextSubtitle);

        await press('Enter', 13);
        await waitFor("(document.querySelector('#subtitleLayer') || {}).textContent === 'Second English line'",
            'English subtitle drawn');
        check('selecting a text track redraws immediately', true);

        var textChoice = await evaluate("Store.pref('subtitleChoices', {})['item:movie1']");
        check('text choice persists for the movie',
            !!textChoice && textChoice.language === 'eng', JSON.stringify(textChoice));

        /* Reopen on the saved row, then turn subtitles off. */
        await press('Enter', 13);
        await waitFor("!document.querySelector('#subtitlePanel').classList.contains('hidden')", 'picker reopened');
        check('picker reopens on the saved track',
            (await evaluate("(document.querySelector('#subtitleList .sub-row.selected .sub-name') || {}).textContent")) === 'English');

        await press('ArrowUp', 38);
        await press('ArrowUp', 38);
        await waitFor("(document.activeElement.querySelector('.sub-name') || {}).textContent === 'Off'", 'Off focused');
        await press('Enter', 13);
        await waitFor("document.querySelector('#subtitleLayer').classList.contains('hidden')", 'subtitle cleared');
        check('Off clears the overlay immediately', true);

        var offChoice = await evaluate("Store.pref('subtitleChoices', {})['item:movie1']");
        check('Off choice persists for the movie', !!offChoice && offChoice.off === true,
            JSON.stringify(offChoice));

        /* An image track cannot be drawn locally: it must reopen the item on a
           transcode with that track burned into the picture. */
        await press('Enter', 13);
        await waitFor("!document.querySelector('#subtitlePanel').classList.contains('hidden')", 'picker for image track');
        await press('ArrowDown', 40);
        await press('ArrowDown', 40);
        await press('ArrowDown', 40);
        await waitFor("(document.activeElement.querySelector('.sub-name') || {}).textContent === 'Japanese'",
            'image track focused');
        var imageMeta = await evaluate("document.activeElement.querySelector('.sub-meta').textContent");
        check('image tracks are labelled as images', /Image/.test(imageMeta), imageMeta);

        await press('Enter', 13);
        await waitFor("window.Player && Player.isOpen() && window.App && App.lastPlayback &&" +
            " App.lastPlayback.method === 'Transcode'", 'burn-in transcode restarted', 30000);
        check('selecting an image track restarts with burn-in', true);
        check('burned-in video draws no text overlay',
            (await evaluate("document.querySelector('#subtitleLayer').textContent")) === '');
        check('the caption control reflects the active track',
            await evaluate("document.querySelector('.osd-btn-subtitles').classList.contains('on')"));

        var imageChoice = await evaluate("Store.pref('subtitleChoices', {})['item:movie1']");
        check('image choice persists for the movie',
            !!imageChoice && /PGSSUB/i.test(imageChoice.codec || ''), JSON.stringify(imageChoice));

        /* ------------------------------------------------ audio picker */

        /* Keep the sample away from its 20 s end while the picker is open. */
        await evaluate("Player.seekTo(7000); true");
        await sleep(200);
        var audioStamp = await evaluate("App.lastPlayback && App.lastPlayback.at");
        await press('ArrowUp', 38);
        await waitFor("document.activeElement.classList.contains('osd-btn-play')", 'play before audio');
        await press('ArrowRight', 39);
        await press('ArrowRight', 39);
        await waitFor("document.activeElement.classList.contains('osd-btn-audio')", 'audio focused');
        await press('Enter', 13);
        await waitFor("!document.querySelector('#audioPanel').classList.contains('hidden')",
            'audio picker open');
        check('audio picker opens from the control row', true);
        await capture('06g-audio-picker');

        var audioRows = await evaluate("document.querySelectorAll('#audioList .sub-row').length");
        check('picker lists every audio track', audioRows === 2, String(audioRows));

        var activeAudio = await evaluate(
            "(document.querySelector('#audioList .sub-row.selected .sub-name') || {}).textContent");
        check('the current audio track is marked', activeAudio === 'English', activeAudio);

        await press('ArrowDown', 40);
        var nextAudio = await evaluate(
            "(document.activeElement.querySelector('.sub-name') || {}).textContent");
        check('down moves through audio tracks', nextAudio === 'French', nextAudio);

        await press('Enter', 13);
        await waitFor("window.Player && Player.isOpen() && App.lastPlayback &&" +
            " App.lastPlayback.at !== " + Number(audioStamp || 0), 'audio transcode restarted', 30000);
        check('selecting an audio track restarts with a transcode',
            (await evaluate("App.lastPlayback.method")) === 'Transcode',
            await evaluate("App.lastPlayback.method"));

        await press('Info', 457);
        await waitFor("!document.querySelector('#playbackInfo').classList.contains('hidden')",
            'audio info panel');
        var audioInfo = await evaluate("document.querySelector('#playbackInfo').textContent");
        check('playback info reports the selected audio',
            /ac3/i.test(audioInfo) && /6 ch/i.test(audioInfo), audioInfo);
        check('transcoding info lists the target codecs and the reason',
            /Transcoding Info/.test(audioInfo) && /H264, AAC, 2 Ch/.test(audioInfo) &&
            /audio codec not supported/.test(audioInfo), audioInfo);
        await capture('06f-info-transcode');
        await press('Unidentified', 10009);
        await waitFor("document.querySelector('#playbackInfo').classList.contains('hidden')",
            'audio info closed');
        check('BACK closes the info panel after an audio switch', await evaluate("Player.isOpen()"));

        /* ----------------------------------------- remembered audio language */

        /* Picking French above is remembered for this title, so playing it
           again must start on the French track (Index 5) with no new pick. */
        var rememberStamp = await evaluate("App.lastPlayback.at");
        await evaluate("App.playItem(Player.getItem(), { startTicks: 0 }); true");
        await waitFor("window.Player && Player.isOpen() && App.lastPlayback &&" +
            " App.lastPlayback.at !== " + Number(rememberStamp || 0), 'replay with remembered audio', 30000);
        var rememberedUrl = await evaluate("(Player.getMediaSource() || {}).TranscodingUrl || ''");
        check('a picked audio language is remembered for the title',
            /AudioStreamIndex=5\b/.test(rememberedUrl), rememberedUrl);

        /* The Settings language applies to a title with nothing remembered. */
        await evaluate("Store.setPref('audioChoices', {}); Store.setPref('audioLanguage', 'fra'); true");
        var settingStamp = await evaluate("App.lastPlayback.at");
        await evaluate("App.playItem(Player.getItem(), { startTicks: 0 }); true");
        await waitFor("window.Player && Player.isOpen() && App.lastPlayback &&" +
            " App.lastPlayback.at !== " + Number(settingStamp || 0), 'replay with Settings language', 30000);
        var settingUrl = await evaluate("(Player.getMediaSource() || {}).TranscodingUrl || ''");
        check('the Settings audio language starts the title in that language',
            /AudioStreamIndex=5\b/.test(settingUrl), settingUrl);
        await evaluate("Store.setPref('audioLanguage', ''); Store.setPref('audioChoices', {}); true");

        await evaluate("SyncPlay.emit('load', { itemId: 'ep1', playlistItemId: 'pl-ep1', startTicks: 0, reason: 'NewPlaylist' }); true");
        await waitFor("window.Player && Player.getItem() && Player.getItem().Id === 'ep1'", 'group load');
        check('a SyncPlay load switches to the requested item', true);
        await capture('06b-group-load');

        /* ------------------------------------------------ up next overlay */

        /* Ending an episode must offer the next one; the mock's /Shows/NextUp
           returns ep2, so the same-item guard does not suppress the overlay. */
        await evaluate("Player.emit('ended'); true");
        await waitFor("!document.querySelector('#upNextOverlay').classList.contains('hidden')",
            'up next overlay', 30000);
        check('finishing an episode offers Up Next', true);
        check('Up Next names the next episode',
            /Second Episode/.test(await evaluate("(document.querySelector('#upNextOverlay .upnext-title') || {}).textContent || ''")),
            await evaluate("(document.querySelector('#upNextOverlay .upnext-title') || {}).textContent"));
        check('Up Next starts a countdown',
            /Playing in \d+ seconds/.test(await evaluate("(document.querySelector('#upNextOverlay .upnext-count') || {}).textContent || ''")));
        await capture('06c-upnext');

        check('Up Next focuses Play Now',
            /Play Now/.test(await evaluate("(document.activeElement || {}).textContent || ''")),
            await evaluate("(document.activeElement || {}).textContent || ''"));
        /* OK on the remote, not a synthetic .click(): the player swallows the
           app-level handler, so ENTER has to be wired here explicitly. */
        await press('Enter', 13);
        await waitFor("window.Player && Player.getItem() && Player.getItem().Id === 'ep2'",
            'up next playback', 30000);
        check('Play Now opens the next episode', true);
        check('the Up Next scrim goes away with the overlay',
            await evaluate("document.querySelector('#upNextOverlay').classList.contains('hidden')"));

        await press('Unidentified', 10009);
        await waitFor("document.querySelector('#osd').classList.contains('hidden')", 'osd hidden after stop');
        await waitFor("!!document.querySelector('.cinema-hero')", 'back on detail');
        check('BACK stops playback and returns', true);

        /* ---------------------------------------- series: one season at a time */

        /* A Series is a folder on the server, but it opens the detail screen:
           the season bar fetches episodes by SeasonId, while a folder listing
           of a season can come back with the specials mixed in. */
        check('a series opens its detail screen',
            !(await evaluate("UI.isFolder({ Type: 'Series', IsFolder: true })")));

        await evaluate("App.go('detail', { itemId: 'series1' }); true");
        await waitFor("document.querySelectorAll('.season-bar .btn').length === 2", 'season bar');
        var seasonLabels = await evaluate(
            "Array.prototype.map.call(document.querySelectorAll('.season-bar .btn'), function (b) { return b.textContent; })");
        check('series detail lists specials and season 1',
            seasonLabels.join(',') === 'Specials,Season 1', seasonLabels.join(','));
        check('the first real season is selected, not the specials',
            (await evaluate("(document.querySelector('.season-bar .btn.on') || {}).textContent")) === 'Season 1');

        /* The mock returns a Specials episode even when Season 1 is asked for,
           the way Jellyfin 12.4 did for Chernobyl. */
        await waitFor("document.querySelectorAll('.episodes-host .card').length === 2", 'season 1 episodes');
        var season1Names = await evaluate(
            "Array.prototype.map.call(document.querySelectorAll('.episodes-host .card .caption')," +
            " function (n) { return n.textContent; })");
        check('a specials episode does not leak into season 1',
            season1Names.indexOf('Special Feature') === -1, season1Names.join(', '));

        await evaluate("Array.prototype.filter.call(document.querySelectorAll('.season-bar .btn')," +
            " function (b) { return b.textContent === 'Specials'; })[0].click(); true");
        await waitFor("document.querySelectorAll('.episodes-host .card').length === 1", 'specials episodes');
        check('specials keep their own episodes',
            /Special Feature/.test(await evaluate("document.querySelector('.episodes-host').textContent")),
            await evaluate("document.querySelector('.episodes-host').textContent"));

        /* ------------------------------------------------------- discover */

        await evaluate("Store.setPref('watchRegion', 'US'); App.go('discover'); true");
        await waitFor("(document.querySelector('.stage-title') || {}).textContent === 'The Matrix'",
            'discover stage', 30000);
        check('discover renders a stage for the first trending title', true);
        var discoverRows = await evaluate(
            "Array.prototype.map.call(document.querySelectorAll('.row-title'), function (n) { return n.textContent; })"
        );
        check('discover fills every discovery row',
            ['Trending', 'Popular Movies', 'Popular TV', 'Upcoming Movies'].every(function (title) {
                return discoverRows.indexOf(title) !== -1;
            }), discoverRows.join(', '));
        check('discover cards carry availability badges',
            (await evaluate("document.querySelectorAll('.remote-card .badge').length")) > 0);
        await capture('08-discover');

        await evaluate("document.querySelector('.remote-card').click(); true");
        await waitFor("(document.querySelector('.cinema-hero .stage-title') || {}).textContent === 'The Matrix'",
            'seerr movie detail', 30000);
        check('a discover card opens the Seerr detail page', true);
        check('Seerr detail has a Where to Watch panel',
            await evaluate("document.body.innerText.indexOf('Where to Watch') !== -1"));
        check('Seerr detail shows a synopsis',
            (await evaluate("(document.querySelector('.cinema-hero .overview') || {}).textContent || ''")).length > 20);

        var providers = await evaluate("(document.querySelector('.provider-groups') || {}).textContent || ''");
        check('Where to Watch lists the US providers',
            /Max/.test(providers) && /Hulu/.test(providers) && /Availability for US/.test(providers),
            providers.slice(0, 160));
        await capture('08b-seerr-detail');

        check('detail starts with a watchlist action',
            await evaluate(detailButton('Watchlist') + " !== undefined"));
        await evaluate(detailButton('Watchlist') + ".click(); true");
        await waitFor(detailButton('In Watchlist') + " !== undefined", 'watchlist added');
        check('watchlist adds the title', true);
        await evaluate(detailButton('In Watchlist') + ".click(); true");
        await waitFor(detailButton('Watchlist') + " !== undefined", 'watchlist removed');
        check('watchlist removes the title again', true);

        /* The region filter is local: the same title must show a different
           provider set once the preference changes. */
        await evaluate("Store.setPref('watchRegion', 'RO');" +
            " App.go('seerrDetail', { mediaType: 'movie', tmdbId: 603, title: 'The Matrix' }); true");
        await waitFor("(document.querySelector('.provider-groups') || {}).textContent.indexOf('Netflix') !== -1",
            'Romanian providers', 30000);
        var roProviders = await evaluate("(document.querySelector('.provider-groups') || {}).textContent || ''");
        check('changing the region filters Where to Watch',
            /Netflix/.test(roProviders) && /Availability for RO/.test(roProviders), roProviders.slice(0, 160));
        await evaluate("Store.setPref('watchRegion', ''); true");

        /* A missing movie can be requested and the request cancelled. */
        await evaluate("App.go('seerrDetail', { mediaType: 'movie', tmdbId: 27205, title: 'Inception' }); true");
        await waitFor("(document.querySelector('.cinema-hero .stage-title') || {}).textContent === 'Inception'",
            'missing movie detail', 30000);
        check('a missing movie offers Request Movie',
            await evaluate(detailButton('Request Movie') + " !== undefined"));

        await evaluate(detailButton('Request Movie') + ".click(); true");
        await waitFor(detailButton('Requested') + " !== undefined", 'movie requested', 30000);
        check('requesting a movie marks it as requested', true);
        check('the request reached Seerr',
            (await evaluate("Seerr.requests().then(function (list) { return list.length; })")) === 1);
        await capture('08c-seerr-request');

        await evaluate(detailButton('Cancel Request') + ".click(); true");
        await waitFor(detailButton('Request Movie') + " !== undefined", 'movie request cancelled', 30000);
        check('cancelling the request restores the request button', true);

        /* A series requests only the seasons that are missing. */
        await evaluate("App.go('seerrDetail', { mediaType: 'tv', tmdbId: 1399, title: 'Game of Thrones' }); true");
        await waitFor("(document.querySelector('.cinema-hero .stage-title') || {}).textContent === 'Game of Thrones'",
            'seerr series detail', 30000);
        check('series detail lists every season',
            (await evaluate("document.querySelectorAll('.season-row').length")) === 3);
        var seasonText = await evaluate(
            "Array.prototype.map.call(document.querySelectorAll('.season-row'), function (n) { return n.textContent; })"
        );
        check('available, requested and missing seasons are distinguished',
            /Available/.test(seasonText[0]) && /Requested/.test(seasonText[1]) &&
            !/Available/.test(seasonText[2]) && !/Requested/.test(seasonText[2]),
            seasonText.join(' | '));
        check('missing seasons start selected',
            await evaluate("document.querySelectorAll('.season-row')[2].classList.contains('selected')"));
        check('the request button counts the selected seasons',
            await evaluate("Array.prototype.filter.call(document.querySelectorAll('.btn')," +
                " function (b) { return b.textContent === 'Request 1 Season'; }).length === 1"));
        await evaluate("U.focusNode(document.querySelector('.season-row:not([data-disabled])')); true");
        await sleep(400);
        await capture('08d-seerr-seasons');

        await evaluate("Array.prototype.filter.call(document.querySelectorAll('.btn')," +
            " function (b) { return b.textContent === 'Request 1 Season'; })[0].click(); true");
        await waitFor("document.querySelectorAll('.season-row')[2].textContent.indexOf('Requested') !== -1",
            'season requested', 30000);
        check('requesting a season marks it as requested', true);
        check('the season request carried the chosen season',
            await evaluate("Seerr.requests().then(function (list) {" +
                " var last = list[list.length - 1];" +
                " return !!(last && last.seasons && last.seasons.length === 1 && last.seasons[0] === 3);" +
                "})"));

        /* --------------------------------------------------------- search */

        await evaluate("App.go('search'); true");
        await waitFor("!!document.querySelector('#searchInput')", 'search screen');
        await waitFor("document.querySelector('#searchInput').placeholder.indexOf('Seerr') !== -1",
            'Seerr search ready');
        check('search knows whether Seerr is available',
            /library and Seerr/.test(await evaluate("document.querySelector('#searchInput').placeholder")));

        await waitFor("document.activeElement && document.activeElement.id === 'searchInput'",
            'search field focus');
        check('the search field is readonly until OK',
            (await evaluate("document.querySelector('#searchInput').readOnly")) === true);
        await press('Enter', 13);
        await sleep(120);
        check('OK starts editing the search field',
            (await evaluate("var i=document.querySelector('#searchInput');" +
                " i.readOnly === false && document.activeElement === i")) === true);
        await press('Enter', 13);
        await sleep(120);
        check('Enter stops editing and keeps focus on the search field',
            (await evaluate("var i=document.querySelector('#searchInput');" +
                " i.readOnly === true && document.activeElement === i")) === true);
        await press('ArrowDown', 40);
        check('down from the search field reaches the Search button',
            (await evaluate("document.activeElement.getAttribute('data-key')")) === 'search-go');

        /* BACK closes the keyboard but stays on the field; a mouse click on a
           readonly field starts editing too (the desktop path). */
        await evaluate("U.focusNode(document.querySelector('#searchInput')); true");
        await press('Enter', 13);
        await sleep(120);
        await press('Unidentified', 10009);
        await sleep(120);
        check('BACK while editing closes the keyboard and keeps the field',
            (await evaluate("var i=document.querySelector('#searchInput');" +
                " i.readOnly === true && document.activeElement === i && !!document.querySelector('.search-results')")) === true);
        await evaluate("document.querySelector('#searchInput').click(); true");
        check('clicking a readonly field starts editing',
            (await evaluate("document.querySelector('#searchInput').readOnly")) === false);

        await evaluate("var i = document.querySelector('#searchInput'); i.value = 'matrix';" +
            " i.dispatchEvent(new Event('input', { bubbles: true })); true");
        await waitFor("!!document.querySelector('.search-results .remote-card')", 'Seerr search hit');
        var searchStatus = await evaluate("document.querySelector('.page-head .count').textContent");
        check('search returns a Seerr result', /The Matrix/.test(
            await evaluate("document.querySelector('.search-results .remote-card').getAttribute('aria-label')")));
        check('search reports the result count', searchStatus === '1 result', searchStatus);
        await capture('09-search');

        await evaluate("var i = document.querySelector('#searchInput'); i.value = 'bunny';" +
            " i.dispatchEvent(new Event('input', { bubbles: true })); true");
        await waitFor("document.body.innerText.indexOf('In Your Library') !== -1", 'library search hit');
        check('search also finds items in the Jellyfin library',
            /Big Buck Bunny/.test(await evaluate("document.querySelector('.search-results').textContent")));

        await evaluate("App.go('settings'); true");
        await waitFor("(document.querySelector('h1.title') || {}).textContent === 'Settings'", 'settings screen');
        await waitFor("document.body.innerText.indexOf('Seerr discovery: Connected') !== -1",
            'seerr status');
        check('settings reports Seerr as connected', true);

        /* Settings has no text boxes: each option opens its own screen. */
        check('settings has no inline text boxes for Seerr',
            (await evaluate("document.querySelectorAll('.list input').length")) === 0);
        check('settings starts on the API key connection',
            (await evaluate("Seerr.mode()")) === 'key');

        function clickButton(label) {
            return evaluate("Array.prototype.filter.call(document.querySelectorAll('.btn, .list-row'), function (b) {" +
                " return b.className.indexOf('list-row') !== -1 ? b.textContent.indexOf(" + JSON.stringify(label) + ") === 0" +
                " : b.textContent === " + JSON.stringify(label) + "; })[0].click(); true");
        }
        async function backOnSettings(text) {
            await waitFor("(document.querySelector('h1.title') || {}).textContent === 'Settings' &&" +
                " document.body.innerText.indexOf(" + JSON.stringify(text) + ") !== -1", 'settings: ' + text, 20000);
        }

        /* Option: Jellyfin password. A wrong one stays on the prompt. */
        await clickButton('Use Jellyfin Password');
        await waitFor("!!document.querySelector('#seerrInput')", 'password prompt');
        await waitFor("document.activeElement && document.activeElement.id === 'seerrInput'",
            'Seerr field focus');
        check('the Seerr field is readonly until OK',
            (await evaluate("document.querySelector('#seerrInput').readOnly")) === true);
        await press('Enter', 13);
        await sleep(120);
        check('OK on the Seerr field raises the keyboard layout',
            (await evaluate("document.querySelector('.screen.setup').classList.contains('typing')")) === true);
        check('the password prompt keeps its field in the top half, above the TV keyboard',
            (await evaluate("document.querySelector('#seerrInput').getBoundingClientRect().bottom")) < 540);
        expect401 = true;   /* the wrong password deliberately gets a 401 */
        await evaluate("document.querySelector('#seerrInput').value = 'nope';" +
            " document.querySelector('#seerrGo').click(); true");
        await waitFor("document.querySelector('#seerrErr').textContent.length > 0", 'wrong password message');
        expect401 = false;
        check('a wrong Jellyfin password is rejected and keeps the old connection',
            (await evaluate("Seerr.mode()")) === 'key' &&
            (await evaluate("!!document.querySelector('#seerrInput')")) === true);
        await evaluate("document.querySelector('#seerrInput').value = 'dev';" +
            " document.querySelector('#seerrGo').click(); true");
        await backOnSettings('Jellyfin sign-in');
        check('Jellyfin password connects Seerr without an API key',
            (await evaluate("Seerr.mode() + ':' + Store.pref('seerrKey', '')")) === 'session:');
        check('the session works for real Seerr calls',
            (await evaluate("Seerr.trending().then(function (l) { return l.length > 0; })")) === true);

        /* Disconnect keeps the address, so Quick Connect is one press. */
        await clickButton('Disconnect Seerr');
        await waitFor("document.body.innerText.indexOf('Not connected') !== -1", 'disconnected');
        check('disconnecting forgets the login but keeps the address',
            (await evaluate("Seerr.mode() + ':' + Seerr.configured() + ':' + (Seerr.url().length > 0)")) === ':false:true');

        /* Option: Quick Connect. The TV approves Seerr's code with its own
           Jellyfin login, so nothing is typed. */
        await clickButton('Quick Connect');
        await backOnSettings('Jellyfin sign-in');
        check('Quick Connect signs in with no typing',
            (await evaluate("Seerr.mode() + ':' + Store.pref('seerrKey', '')")) === 'session:');

        /* With no address saved, an option asks for it first, starting from the
           Jellyfin host on port 5055. */
        await evaluate("Seerr.disconnect().then(function () { Store.setPref('seerrUrl', ''); window.__off = 1; })");
        await waitFor("window.__off === 1", 'address cleared');
        await evaluate("window.__off = 0; App.go('settings'); true");
        await waitFor("document.body.innerText.indexOf('Not set') !== -1", 'address not set');
        await clickButton('Quick Connect');
        await waitFor("!!document.querySelector('#seerrInput')", 'address prompt');
        check('the address prompt starts from the Jellyfin host on port 5055',
            (await evaluate("document.querySelector('#seerrInput').value")) === 'http://localhost:5055');
        await evaluate("document.querySelector('#seerrInput').value = location.origin + '/seerr';" +
            " document.querySelector('#seerrGo').click(); true");
        await backOnSettings('Jellyfin sign-in');
        check('after the address, Quick Connect continues and connects',
            (await evaluate("Seerr.mode() + ':' + Seerr.url()")) === 'session:' + (await evaluate("location.origin")) + '/seerr');

        /* When the TV cannot approve the code itself, the code is shown so it can
           be entered in Jellyfin on another device. */
        await evaluate("Seerr.disconnect().then(function () {" +
            " var real = Api.quickConnectAuthorize;" +
            " Api.quickConnectAuthorize = function () { return Promise.reject(new Error('cannot approve')); };" +
            " Seerr.quickConnect(location.origin + '/seerr', { onCode: function (code) {" +
            "   window.__qcCode = code; setTimeout(function () { real.call(Api, code); }, 300); } })" +
            ".then(function () { Api.quickConnectAuthorize = real; window.__qcDone = true; }); })");
        await waitFor("window.__qcDone === true", 'manual quick connect', 20000);
        check('an unapproved code is shown for manual entry',
            /^\d{6}$/.test(await evaluate("window.__qcCode")));
        check('the manually approved code signs in', (await evaluate("Seerr.mode()")) === 'session');

        /* Option: API key. A key Seerr rejects must not replace a working login. */
        await clickButton('Use API Key');
        await waitFor("!!document.querySelector('#seerrInput')", 'api key prompt');
        await evaluate("document.querySelector('#seerrInput').value = ''; document.querySelector('#seerrGo').click(); true");
        await waitFor("document.querySelector('#seerrErr').textContent.length > 0", 'empty key message');
        await evaluate("document.querySelector('#seerrInput').value = 'dev-key';" +
            " document.querySelector('#seerrGo').click(); true");
        await backOnSettings('API key');
        check('an API key still works', (await evaluate("Seerr.mode()")) === 'key');

        /* The address row changes the address; a new address drops the old login. */
        await clickButton('Seerr address');
        await waitFor("!!document.querySelector('#seerrInput')", 'address row prompt');
        check('the address row shows the saved address',
            /\/seerr$/.test(await evaluate("document.querySelector('#seerrInput').value")));
        await evaluate("document.querySelector('#seerrCancel').click(); true");
        await backOnSettings('API key');
        check('cancelling the address prompt changes nothing', (await evaluate("Seerr.mode()")) === 'key');

        var diagnostics = await evaluate(
            "Array.prototype.filter.call(document.querySelectorAll('.status-line')," +
            " function (n) { return /Engine/.test(n.textContent); })[0].textContent");
        check('settings reports the playback engine', /HTML5/.test(diagnostics), diagnostics);

        var audioRowsText = await evaluate(
            "['set-Audio output','set-Audio language','set-Allow HEVC direct play'].map(function (k) {" +
            " var n = document.querySelector('[data-key=\"' + k + '\"]'); return n ? n.textContent : ''; }).join('|')");
        check('settings offers the audio output, language and HEVC options',
            /Surround/.test(audioRowsText) && /Auto/.test(audioRowsText) && /Off/.test(audioRowsText), audioRowsText);

        var topIcons = await evaluate("document.querySelectorAll('.btn svg.icon').length");
        check('settings buttons carry icons', topIcons >= 2, String(topIcons));
        check('settings reports the last negotiated stream', /Last playback: /.test(diagnostics), diagnostics);

        /* The transcode URL is where the resolution is pinned now that the
           bitrate is uncapped: whatever the server chose, and whatever the
           source was, the client asks for at most 1920x1080. */
        var limited = await evaluate("(function () {" +
            "  return [" +
            "    Api.limitResolution('http://h/videos/1/master.m3u8')," +
            "    Api.limitResolution('http://h/v?width=3840&height=2160&VideoCodec=h264')," +
            "    Api.limitResolution('http://h/v?maxWidth=3840&maxHeight=2160&VideoBitrate=99')" +
            "  ];" +
            "})()");
        check('transcode URL pinned to 1920x1080',
            limited[0] === 'http://h/videos/1/master.m3u8?maxWidth=1920&maxHeight=1080' &&
            limited[1] === 'http://h/v?VideoCodec=h264&maxWidth=1920&maxHeight=1080' &&
            limited[2] === 'http://h/v?VideoBitrate=99&maxWidth=1920&maxHeight=1080',
            JSON.stringify(limited));

        /* The token is appended to the stream URL, so a server-supplied
           absolute URL must not be allowed to point at another host. */
        var absolute = await evaluate("(function () {" +
            "  var base = Api.base.replace(/\\/$/, '');" +
            "  return {" +
            "    foreign: Api.absoluteUrl('https://evil.example/x.m3u8')," +
            "    same: Api.absoluteUrl(base + '/x.m3u8')," +
            "    base: base" +
            "  };" +
            "})()");
        check('a foreign absolute stream URL is rebased onto the server',
            absolute.foreign.indexOf('evil.example') === -1 &&
            absolute.foreign === absolute.base + '/x.m3u8', absolute.foreign);
        check('a same-server absolute URL is kept', absolute.same === absolute.base + '/x.m3u8');

        var qualityRow = await evaluate("Array.prototype.some.call(document.querySelectorAll('.list-title')," +
            " function (n) { return n.textContent === 'Transcode quality'; })");
        check('no transcode bitrate setting', qualityRow === false);
        await capture('07-settings');

        /* ---------------------------------------------- two users, one TV */

        await clickButton('Switch user');
        await waitFor("!!document.querySelector('.account-card')", 'account picker');
        check('the picker lists the signed-in account and an add card',
            (await evaluate("document.querySelectorAll('.account-card').length")) === 2 &&
            /dev/i.test(await evaluate("document.body.innerText")));
        check('the picker is not the server form',
            (await evaluate("!document.querySelector('#serverUrl')")) === true);

        await evaluate("Array.prototype.filter.call(document.querySelectorAll('.account-card')," +
            " function (b) { return b.className.indexOf('add') !== -1; })[0].click(); true");
        await waitFor("!!document.querySelector('#serverUrl')", 'server form after add account');

        /* Backing out of "Add account" must not leave the live session with
           the empty token the server probe installed. The focused field is
           readonly now, so one BACK is a real BACK. */
        await press('Unidentified', 10009);
        await waitFor("(document.querySelector('h1.title') || {}).textContent === 'Settings'",
            'settings after backing out of add account');
        check('backing out of add account restores the live session',
            await evaluate("Api.token === Store.auth().token && !!Api.token"));

        await clickButton('Switch user');
        await waitFor("!!document.querySelector('.account-card')", 'picker again');
        await evaluate("Array.prototype.filter.call(document.querySelectorAll('.account-card')," +
            " function (b) { return b.className.indexOf('add') !== -1; })[0].click(); true");
        await waitFor("!!document.querySelector('#serverUrl')", 'server form after add account');
        await evaluate("document.querySelector('#serverUrl').value='localhost:" + PORT + "'; true");
        await evaluate("document.querySelector('#connectBtn').click(); true");
        await waitFor("!!document.querySelector('#username')", 'login for the second account');
        await evaluate("document.querySelector('#username').value='alex';" +
            " document.querySelector('#password').value='dev';" +
            " U.focusNode(document.querySelector('#password')); true");
        /* Enter in edit mode on the last field still signs in. */
        await press('Enter', 13);
        await sleep(120);
        await press('Enter', 13);
        await waitFor("Store.accounts().length === 2 && Store.auth().userName === 'alex'",
            'second account signed in');
        check('a second account signs in without losing the first',
            (await evaluate("Store.accounts().map(function (a) { return a.userName; }).sort().join(',')")) ===
            'alex,dev');

        await evaluate("App.go('settings'); true");
        await waitFor("(document.querySelector('h1.title') || {}).textContent === 'Settings'",
            'settings for the second user');
        await clickButton('Switch user');
        await waitFor("!!document.querySelector('.account-card')", 'picker with two accounts');
        check('the picker shows both accounts plus add',
            (await evaluate("document.querySelectorAll('.account-card').length")) === 3);
        await capture('08-accounts');
        await evaluate("Array.prototype.filter.call(document.querySelectorAll('.account-card')," +
            " function (b) { return /dev/i.test(b.textContent); })[0].click(); true");
        await waitFor("Store.auth().userName === 'dev'", 'switched back to dev');
        check('switching restores the other account',
            await evaluate("Api.token === Store.auth().token && Store.isLoggedIn()"));

        /* ------------------------------------------------------------ 401 */

        /* A dead token anywhere must return to the picker instead of leaving
           every screen stuck on "HTTP 401". Done last because it signs the
           active account out. */
        expect401 = true;
        await evaluate("Store.setPref('seerrKey', 'secret'); Store.setPref('seerrMode', 'key'); true");
        await evaluate("Api.configure({ serverUrl: Store.auth().serverUrl," +
            " token: 'expired-token', userId: Store.auth().userId," +
            " deviceId: Store.deviceId() }); Api.views().catch(function () {}); true");
        await waitFor("!!document.querySelector('.account-card')", 'picker after a 401');
        check('a 401 drops only the failing account and offers the picker',
            (await evaluate("Store.accounts().length")) === 1 &&
            (await evaluate("Store.accounts()[0].userName")) === 'alex');
        check('the dead token is not kept', await evaluate("!Store.isLoggedIn()"));
        check('a 401 also forgets the failing account\'s Seerr connection',
            await evaluate("!Store.pref('seerrKey') && !Store.pref('seerrMode')"));

        /* With nobody left, setup falls back to the server form. */
        await evaluate("Store.removeAccount(Store.accounts()[0].id); App.go('setup', {}, true); true");
        await waitFor("!!document.querySelector('#serverUrl')", 'setup after the last account');
        check('setup returns to the server form when no account remains', true);

        await sleep(300);

        if (errors.length) {
            throw new Error('Browser errors:\n  - ' + errors.join('\n  - '));
        }

        console.log('');
        console.log('PASS: ' + checks.length + ' checks, no console errors');
    } catch (e) {
        console.error('');
        console.error('FAIL: ' + e.message);
        process.exitCode = 1;
    } finally {
        if (chrome) { try { chrome.kill('SIGKILL'); } catch (e) { /* ignore */ } }
        if (server) { try { server.kill('SIGKILL'); } catch (e) { /* ignore */ } }
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
}

main();

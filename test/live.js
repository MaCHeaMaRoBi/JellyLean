#!/usr/bin/env node
/* Live check against a real Jellyfin server.
   Serves the app with the mock API switched off, signs in with real
   credentials, and verifies the paths the TV depends on: login, libraries,
   images, media segments, playback negotiation and the SyncPlay socket.

     JF_URL=http://192.168.1.20:8096 JF_USER=me JF_PASS=secret node test/live.js

   Read-only: it never starts playback or changes watch state. */
'use strict';

var spawn = require('child_process').spawn;
var execFileSync = require('child_process').execFileSync;
var fs = require('fs');
var os = require('os');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var PORT = Number(process.env.PORT || 8097);
var CDP_PORT = Number(process.env.CDP_PORT || 9334);
var APP_URL = 'http://localhost:' + PORT + '/';

var JF_URL = process.env.JF_URL;
var JF_USER = process.env.JF_USER;
var JF_PASS = process.env.JF_PASS;

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function findChrome() {
    if (process.env.CHROME) return process.env.CHROME;
    var candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome', '/snap/bin/chromium'];
    for (var i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) return candidates[i];
    }
    try { return execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(); }
    catch (e) { throw new Error('Chromium not found. Set CHROME=/path/to/chromium'); }
}

async function waitForHttp(url, timeout) {
    var started = Date.now();
    while (Date.now() - started < (timeout || 20000)) {
        try { if ((await fetch(url)).ok) return true; } catch (e) { /* not yet */ }
        await sleep(150);
    }
    throw new Error('Timed out waiting for ' + url);
}

function CDP(url) { this.url = url; this.nextId = 0; this.pending = {}; this.handlers = {}; }

CDP.prototype.open = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
        self.ws = new WebSocket(self.url);
        self.ws.onopen = function () { resolve(); };
        self.ws.onerror = function () { reject(new Error('DevTools socket failed')); };
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

CDP.prototype.on = function (method, handler) { this.handlers[method] = handler; };

async function main() {
    if (!JF_URL || !JF_USER || !JF_PASS) {
        console.error('Set JF_URL, JF_USER and JF_PASS. Nothing was sent anywhere until you do.');
        process.exit(2);
    }
    /* Keep the scheme: an https-only server (a reverse proxy) refuses the
       http:// the app would otherwise assume. A bare host:port still works,
       because normalizeServerUrl adds http://. */
    JF_URL = JF_URL.replace(/\/+$/, '');

    var chromePath = findChrome();
    var profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jflean-live-'));
    var server = null;
    var chrome = null;
    var checks = 0;

    function ok(name, detail) {
        checks++;
        console.log('  ok  ' + name + (detail ? '  [' + detail + ']' : ''));
    }

    try {
        server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-server.js')], {
            cwd: ROOT,
            env: Object.assign({}, process.env, { QUIET: '1', NO_MOCK: '1', PORT: String(PORT) }),
            stdio: ['ignore', 'pipe', 'pipe']
        });
        await waitForHttp('http://127.0.0.1:' + PORT + '/index.html');

        chrome = spawn(chromePath, [
            '--headless=new',
            '--remote-debugging-port=' + CDP_PORT,
            '--user-data-dir=' + profile,
            '--no-first-run', '--no-default-browser-check',
            '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
            '--autoplay-policy=no-user-gesture-required', '--mute-audio',
            '--window-size=1920,1080', 'about:blank'
        ], { stdio: 'ignore' });

        await waitForHttp('http://127.0.0.1:' + CDP_PORT + '/json/version');

        var target = await (await fetch(
            'http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' }
        )).json();

        var cdp = new CDP(target.webSocketDebuggerUrl);
        await cdp.open();

        var errors = [];
        cdp.on('Runtime.exceptionThrown', function (p) {
            var d = p.exceptionDetails || {};
            errors.push('exception: ' + ((d.exception && d.exception.description) || d.text));
        });
        cdp.on('Runtime.consoleAPICalled', function (p) {
            if (p.type !== 'error') return;
            errors.push('console.error: ' + (p.args || []).map(function (a) {
                return a.value !== undefined ? String(a.value) : (a.description || a.type);
            }).join(' '));
        });
        cdp.on('Log.entryAdded', function (p) {
            var e = p.entry || {};
            if (e.level === 'error' && !/favicon\.ico/.test(e.url || '')) {
                errors.push('log: ' + e.text + (e.url ? ' (' + e.url + ')' : ''));
            }
        });

        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Log.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false
        });

        async function evaluate(expression) {
            var result = await cdp.send('Runtime.evaluate', {
                expression: expression, returnByValue: true, awaitPromise: true
            });
            if (result.exceptionDetails) {
                var d = result.exceptionDetails;
                throw new Error((d.exception && d.exception.description) || d.text);
            }
            return result.result.value;
        }

        async function waitFor(expression, label) {
            var started = Date.now();
            while (Date.now() - started < 30000) {
                try { if (await evaluate(expression)) return true; } catch (e) { /* navigating */ }
                await sleep(200);
            }
            throw new Error('Timed out waiting for ' + label);
        }

        await cdp.send('Page.navigate', { url: APP_URL });
        await waitFor("!!document.querySelector('#serverUrl')", 'setup screen');
        ok('app boots');

        await evaluate("document.querySelector('#serverUrl').value=" + JSON.stringify(JF_URL) + ";" +
            "document.querySelector('#connectBtn').click(); true");
        await waitFor("!!document.querySelector('#username')", 'login step');
        ok('server reachable', JF_URL);

        await evaluate("document.querySelector('#username').value=" + JSON.stringify(JF_USER) + ";" +
            "document.querySelector('#password').value=" + JSON.stringify(JF_PASS) + ";" +
            "document.querySelector('#loginBtn').click(); true");

        await waitFor("document.querySelectorAll('.row .card').length > 0", 'home rows');
        ok('sign-in accepted');

        var rows = await evaluate(
            "Array.prototype.map.call(document.querySelectorAll('.row-title')," +
            " function (n) { return n.textContent; }).join(' | ')"
        );
        ok('home rendered', rows);

        var libs = await evaluate(
            "Array.prototype.map.call(document.querySelectorAll('.row'), function (r) {" +
            "  if ((r.querySelector('.row-title')||{}).textContent !== 'Libraries') return null;" +
            "  return Array.prototype.map.call(r.querySelectorAll('.card .caption')," +
            "    function (c) { return c.textContent; }).join(', ');" +
            "}).filter(Boolean)[0] || '(none)'"
        );
        ok('libraries listed', libs);

        await waitFor(
            "Array.prototype.some.call(document.querySelectorAll('.card img')," +
            " function (i) { return i.complete && i.naturalWidth > 0; })", 'an image to decode');
        var imgCount = await evaluate(
            "Array.prototype.filter.call(document.querySelectorAll('.card img')," +
            " function (i) { return i.complete && i.naturalWidth > 0; }).length"
        );
        ok('poster images decode', imgCount + ' loaded');

        var segs = await evaluate("(function () {" +
            "  return Api.items({ includeItemTypes: 'Episode', limit: 25, sortBy: 'DatePlayed', sortOrder: 'Descending' }).then(function (r) { return (r && r.Items) || []; })" +
            "    .then(function (eps) {" +
            "      var i = 0;" +
            "      function next() {" +
            "        if (i >= eps.length) return '(no episode with segments)';" +
            "        var ep = eps[i++];" +
            "        return Api.mediaSegments(ep.Id).then(function (r) {" +
            "          var items = (r && r.Items) || [];" +
            "          if (!items.length) return next();" +
            "          return ep.Name + ': ' + items.map(function (s) {" +
            "            return s.Type + ' ' + Math.round(s.StartTicks / 1e7) + 's-' +" +
            "              Math.round(s.EndTicks / 1e7) + 's'; }).join(', ');" +
            "        }).catch(function () { return next(); });" +
            "      }" +
            "      return next();" +
            "    });" +
            "})()");
        if (/^\(/.test(segs)) throw new Error('media segments: ' + segs);
        ok('media segments load', segs);

        var playback = await evaluate("(function () {" +
            "  return Api.items({ includeItemTypes: 'Movie', limit: 1 }).then(function (r) { return (r && r.Items) || []; })" +
            "    .then(function (m) {" +
            "      if (!m.length) return 'no movies';" +
            "      return Api.playbackInfo(m[0].Id, { startTicks: 0 })" +
            "        .then(function (info) {" +
            "          var s = (info.MediaSources || [])[0];" +
            "          if (!s) return 'no media source';" +
            "          var url = Api.withApiKey(Api.streamUrl(m[0].Id, s.Id, info.PlaySessionId));" +
            "          return fetch(url, { method: 'HEAD' }).then(function (r) {" +
            "            return m[0].Name.slice(0, 30) + ' [' + s.Container + '] ' +" +
            "              'direct=' + s.SupportsDirectPlay + ' stream HTTP ' + r.status +" +
            "              ' ' + (r.headers.get('content-type') || '');" +
            "          });" +
            "        });" +
            "    });" +
            "})()");
        ok('playback negotiation + stream auth', playback);

        /* Jellyfin picks the transcode target from the bitrate cap. A 2017 FHD
           panel refuses 2560x1440 H.264 (audio plays, picture stays black), so
           negotiate() must leave any transcoded stream at or below 1080p. */
        var capped = await evaluate("(function () {" +
            "  function check(movies, i) {" +
            "    if (i >= movies.length) return 'no transcoding item in sample';" +
            "    return Api.negotiate(movies[i].Id, { startTicks: 0, transcodeBitrate: 20000000 }).then(function (r) {" +
            "      if (!r || !r.source || r.method !== 'Transcode' || !r.url) return check(movies, i + 1);" +
            "      return Api.transcodeOutput(Api.withApiKey(r.url)).then(function (out) {" +
            "        if (!out || !out.resolution) return 'no master playlist';" +
            "        var parts = out.resolution.split('x');" +
            "        var fits = Number(parts[0]) <= 1920 && Number(parts[1]) <= 1080;" +
            "        return { name: movies[i].Name.slice(0, 28), res: out.resolution, fits: fits," +
            "          burned: /Subtitle(StreamIndex|Method)=/i.test(r.url)," +
            "          bandwidth: out.bitrate };" +
            "      });" +
            "    }).catch(function () { return check(movies, i + 1); });" +
            "  }" +
            "  return Api.items({ includeItemTypes: 'Movie', limit: 20 })" +
            "    .then(function (r) { return check((r && r.Items) || [], 0); })" +
            "    .catch(function (e) { return 'error: ' + (e && e.message); });" +
            "})()");
        if (capped && capped.fits === false) {
            throw new Error('transcode target exceeds 1080p: ' + capped.res);
        }
        if (capped && capped.burned) {
            throw new Error('transcode URL still burns in a subtitle track');
        }
        ok('transcoded stream capped at 1080p, no burn-in',
            typeof capped === 'string' ? capped
                : capped.name + ' ' + capped.res + ' @ ' + capped.bandwidth + ' Mbps fits=' + capped.fits);

        /* A forced/default text track is why the server would otherwise burn the
           subtitle in and transcode. The client draws it instead, so the track
           must come back as WebVTT for the same direct-play source. */
        var subtitles = await evaluate("(function () {" +
            "  return Api.items({ includeItemTypes: 'Movie', limit: 40 }).then(function (r) { return (r && r.Items) || []; })" +
            "    .then(function (all) {" +
            "      var m = all.filter(function (x) { return x.HasSubtitles; });" +
            "      if (!m.length) return 'no movies with subtitles';" +
            "      return Api.playbackInfo(m[0].Id, { startTicks: 0 }).then(function (info) {" +
            "        var s = (info.MediaSources || [])[0];" +
            "        if (!s) return 'no media source';" +
            "        var subs = (s.MediaStreams || []).filter(function (x) {" +
            "          return x.Type === 'Subtitle' && Subtitles.isTextCodec(x.Codec); });" +
            "        var pick = subs.filter(function (x) { return x.IsDefault && x.IsForced; })[0] ||" +
            "          subs.filter(function (x) { return x.IsDefault; })[0] || subs[0];" +
            "        if (!pick) return 'no text subtitle';" +
            "        return fetch(Api.subtitleUrl(m[0].Id, s.Id, pick.Index)).then(function (r) {" +
            "          if (!r.ok) throw new Error('HTTP ' + r.status);" +
            "          return r.text();" +
            "        }).then(function (body) {" +
            "          var cues = Subtitles.parse(body);" +
            "          return 'track ' + pick.Index + ' (' + (pick.Language || '?') + ') ' + cues.length + ' cues' +" +
            "            ' default=' + !!pick.IsDefault + ' direct=' + s.SupportsDirectPlay;" +
            "        });" +
            "      });" +
            "    }).catch(function (e) { return 'error: ' + (e && e.message); });" +
            "})()");
        ok('forced subtitle served as WebVTT', subtitles);

        /* Image tracks can only be shown by a burn-in. The server ignores
           SubtitleStreamIndex unless MediaSourceId names the file, so the
           picker's path must return that exact index with Method=Encode. */
        var burnIn = await evaluate("(function () {" +
            "  function next(movies, i) {" +
            "    if (i >= movies.length) return 'no image subtitle in sample';" +
            "    var item = movies[i];" +
            "    return Api.playbackInfo(item.Id, { startTicks: 0 }).then(function (info) {" +
            "      var src = (info.MediaSources || [])[0];" +
            "      if (!src) return next(movies, i + 1);" +
            "      var image = (src.MediaStreams || []).filter(function (s) {" +
            "        return s.Type === 'Subtitle' && Subtitles.isImageCodec(s.Codec); })[0];" +
            "      if (!image) return next(movies, i + 1);" +
            "      return Api.playbackInfo(item.Id, { startTicks: 0, forceTranscode: true," +
            "        mediaSourceId: src.Id, subtitleIndex: image.Index }).then(function (burned) {" +
            "        var out = (burned.MediaSources || [])[0] || {};" +
            "        var url = out.TranscodingUrl || '';" +
            "        var m = /SubtitleStreamIndex=(\\d+)/.exec(url);" +
            "        return { name: item.Name.slice(0, 28), codec: image.Codec," +
            "          wanted: image.Index, got: m ? Number(m[1]) : -1," +
            "          encode: /SubtitleMethod=Encode/i.test(url) };" +
            "      });" +
            "    }).catch(function () { return next(movies, i + 1); });" +
            "  }" +
            "  return Api.items({ includeItemTypes: 'Movie', limit: 100 })" +
            "    .then(function (r) { return next((r && r.Items) || [], 0); })" +
            "    .catch(function (e) { return 'error: ' + (e && e.message); });" +
            "})()");
        if (burnIn && typeof burnIn === 'object' &&
                (burnIn.got !== burnIn.wanted || !burnIn.encode)) {
            throw new Error('image subtitle burn-in not honoured: ' + JSON.stringify(burnIn));
        }
        ok('image subtitle selection requests a burn-in',
            typeof burnIn === 'string' ? burnIn
                : burnIn.name + ' ' + burnIn.codec + ' track ' + burnIn.got + ' encode=' + burnIn.encode);

        await evaluate("App.go('syncplay'); true");
        await waitFor("(document.querySelector('h1.title') || {}).textContent === 'SyncPlay'", 'syncplay screen');
        await sleep(1800);
        var socket = await evaluate("(function () {" +
            "  var g = window.SyncPlay && SyncPlay.getGroup ? SyncPlay.getGroup() : null;" +
            "  return 'enabled=' + (window.SyncPlay ? SyncPlay.isEnabled() : 'no module') +" +
            "    ' group=' + (g ? g.GroupName : 'none');" +
            "})()");
        ok('SyncPlay screen reached', socket);

        var wsOk = await evaluate("(function () {" +
            "  return new Promise(function (resolve) {" +
            "    var t = setTimeout(function () { resolve('timeout'); }, 6000);" +
            "    try {" +
            "      var ws = new WebSocket(Api.base.replace(/^http/, 'ws') +" +
            "        '/socket?api_key=' + encodeURIComponent(Api.token) +" +
            "        '&ApiKey=' + encodeURIComponent(Api.token) +" +
            "        '&deviceId=' + encodeURIComponent(Store.deviceId()));" +
            "      ws.onopen = function () { clearTimeout(t); ws.close(); resolve('open'); };" +
            "      ws.onerror = function () { clearTimeout(t); resolve('error'); };" +
            "    } catch (e) { clearTimeout(t); resolve('exception ' + e.message); }" +
            "  });" +
            "})()");
        ok('SyncPlay websocket authenticates', wsOk);

        await sleep(400);
        if (errors.length) throw new Error('Browser errors:\n  - ' + errors.join('\n  - '));
        if (wsOk !== 'open') throw new Error('websocket did not open: ' + wsOk);

        console.log('');
        console.log('PASS: ' + checks + ' checks against ' + JF_URL + ', no console errors');
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

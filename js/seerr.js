/* Seerr (Jellyseerr / Overseerr) discovery, talking to Seerr's own REST API.
   Three ways to connect, all set up in Settings:
     - Quick Connect: the TV approves a Seerr Quick Connect code with its own
       Jellyfin login, so nothing is typed at all (Seerr 3.4+ on Jellyfin);
     - the Jellyfin password, typed once;
     - an API key.
   The first two open a "session": Seerr's login cookie does the rest.
   The credentials are only ever sent to the Seerr address, never to the Jellyfin
   server, and the Jellyfin token is never sent to Seerr. */
(function (global) {
    'use strict';

    var ROOT = '/api/v1';
    var QUICK_CONNECT_WAIT_MS = 150000;
    var IMAGE_ROOT = 'https://image.tmdb.org/t/p/';

    var statusCache = null;
    var statusInflight = null;

    function SeerrError(status, message) {
        this.name = 'SeerrError';
        this.status = status;
        this.message = message || ('HTTP ' + status);
    }
    SeerrError.prototype = Object.create(Error.prototype);
    SeerrError.prototype.constructor = SeerrError;

    function queryString(params) {
        var parts = [];
        for (var key in params) {
            if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
            var value = params[key];
            if (value === undefined || value === null || value === '') continue;
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
        }
        return parts.join('&');
    }

    /* Accepts "seerr.lan:5055", "http://seerr.lan:5055/" or a full
       ".../api/v1" address and returns "http://seerr.lan:5055", or ''. */
    function normalizeUrl(value) {
        var text = String(value || '').replace(/^\s+|\s+$/g, '');
        if (!text) return '';
        if (!/^https?:\/\//i.test(text)) text = 'http://' + text;
        text = text.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
        return /^https?:\/\/[^\/\s]+/i.test(text) ? text : '';
    }

    function seerrUrl() { return normalizeUrl(Store.pref('seerrUrl', '')); }
    function seerrKey() { return String(Store.pref('seerrKey', '') || '').replace(/\s+/g, ''); }
    function sessionMode() { return Store.pref('seerrMode', '') === 'session'; }
    function isConfigured() { return !!(seerrUrl() && (seerrKey() || sessionMode())); }

    function target(path, params) {
        var qs = params ? queryString(params) : '';
        return seerrUrl() + ROOT + path + (qs ? '?' + qs : '');
    }

    function call(method, path, body, params) {
        var url = target(path, params);
        var payload = (body === undefined || body === null) ? null : JSON.stringify(body);
        var headers = { 'Accept': 'application/json' };
        if (seerrKey()) headers['X-Api-Key'] = seerrKey();
        if (payload !== null) headers['Content-Type'] = 'application/json';

        function fail(status, text) {
            var message = 'HTTP ' + status;
            try {
                var parsed = JSON.parse(text);
                message = parsed.message || parsed.Message || message;
            } catch (e) { /* not JSON */ }
            if (status === 401 || status === 403) {
                message = seerrKey() ? 'Seerr rejected the API key' : 'The Seerr sign-in has expired';
            }
            return new SeerrError(status, message);
        }

        if (!isConfigured()) {
            return Promise.reject(new SeerrError(0, 'Seerr is not configured'));
        }

        if (!global.fetch) {
            return new Promise(function (resolve, reject) {
                var xhr = new XMLHttpRequest();
                xhr.open(method, url, true);
                xhr.withCredentials = true;
                for (var key in headers) {
                    if (Object.prototype.hasOwnProperty.call(headers, key)) {
                        xhr.setRequestHeader(key, headers[key]);
                    }
                }
                xhr.timeout = 20000;
                xhr.onload = function () {
                    if (xhr.status < 200 || xhr.status >= 300) {
                        reject(fail(xhr.status, xhr.responseText));
                        return;
                    }
                    if (!xhr.responseText) { resolve(null); return; }
                    try { resolve(JSON.parse(xhr.responseText)); } catch (e) { resolve(xhr.responseText); }
                };
                xhr.onerror = function () { reject(new SeerrError(0, 'Network error')); };
                xhr.ontimeout = function () { reject(new SeerrError(0, 'Request timed out')); };
                xhr.send(payload);
            });
        }

        return fetch(url, {
            method: method,
            headers: headers,
            body: payload,
            credentials: 'include',
            cache: 'no-store'
        }).then(function (response) {
            return response.text().then(function (text) {
                if (!response.ok) throw fail(response.status, text);
                if (!text) return null;
                try { return JSON.parse(text); } catch (e) { return text; }
            });
        });
    }

    function results(payload) {
        if (!payload) return [];
        if (Object.prototype.toString.call(payload) === '[object Array]') return payload;
        return payload.results || payload.Items || [];
    }

    /* ------------------------------------------------------------ helpers */

    function image(path, size) {
        if (!path) return '';
        return IMAGE_ROOT + (size || 'w342') + path;
    }

    function titleOf(item) {
        if (!item) return '';
        return item.title || item.name || item.originalTitle || item.originalName || 'Untitled';
    }

    function yearOf(item) {
        if (!item) return '';
        var date = item.releaseDate || item.firstAirDate || item.airDate || '';
        var match = /^(\d{4})/.exec(String(date));
        return match ? match[1] : '';
    }

    function mediaTypeOf(item) {
        if (!item) return 'movie';
        if (item.mediaType === 'tv' || item.mediaType === 'movie') return item.mediaType;
        return (item.name && !item.title) ? 'tv' : 'movie';
    }

    /* Seerr's MediaRequest/MediaInfo status constants. */
    function statusOf(mediaInfo) {
        var status = mediaInfo && mediaInfo.status ? Number(mediaInfo.status) : 0;
        if (status === 5) return { key: 'available', label: 'Available', tone: 'good' };
        if (status === 4) return { key: 'partial', label: 'Partially available', tone: 'warn' };
        if (status === 3) return { key: 'processing', label: 'Processing', tone: 'warn' };
        if (status === 2) return { key: 'pending', label: 'Requested', tone: 'warn' };
        if (status === 6) return { key: 'deleted', label: 'Removed', tone: 'bad' };
        return { key: 'missing', label: 'Not requested', tone: '' };
    }

    /* Region comes from Settings when set, otherwise from the TV locale.
       Seerr returns every region, so this is a local filter. */
    function region() {
        var override = Store.pref('watchRegion', '');
        if (override) return String(override).toUpperCase();

        var language = '';
        try { language = global.navigator && global.navigator.language ? global.navigator.language : ''; } catch (e) { language = ''; }
        var match = /^[a-z]{2,3}[-_]([A-Za-z]{2})/.exec(String(language));
        if (match) return match[1].toUpperCase();

        var map = { ro: 'RO', en: 'US', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', nl: 'NL', pl: 'PL' };
        var base = String(language).slice(0, 2).toLowerCase();
        return map[base] || 'US';
    }

    function providersOf(item, kind) {
        var list = (item && item.watchProviders) || [];
        var code = region();
        var entry = null;

        for (var i = 0; i < list.length; i++) {
            if (String(list[i].iso_3166_1).toUpperCase() === code) { entry = list[i]; break; }
        }
        if (!entry) return null;

        var group = entry[kind] || [];
        if (!group.length) return null;

        var ordered = group.slice().sort(function (a, b) {
            return (a.displayPriority || 999) - (b.displayPriority || 999);
        });
        return ordered;
    }

    /* Switch to session mode for `url`, run the sign-in call, and confirm the
       session works. Any failure restores the connection that was there before. */
    function openSession(url, signIn, missingMessage, apiKey) {
        var base = normalizeUrl(url);
        if (!base) return Promise.reject(new SeerrError(0, 'Enter the Seerr address first'));

        var previous = {
            url: Store.pref('seerrUrl', ''),
            key: Store.pref('seerrKey', ''),
            mode: Store.pref('seerrMode', '')
        };
        function restore() {
            Store.setPref('seerrUrl', previous.url);
            Store.setPref('seerrKey', previous.key);
            Store.setPref('seerrMode', previous.mode);
            statusCache = null;
            statusInflight = null;
        }

        Store.setPref('seerrUrl', base);
        Store.setPref('seerrKey', apiKey || '');
        Store.setPref('seerrMode', apiKey ? '' : 'session');
        statusCache = null;
        statusInflight = null;

        return Promise.resolve().then(signIn)
            .then(function () { return Seerr.status(true); })
            .then(function (status) {
                if (!status || !status.available) {
                    /* With a key, the real reason (wrong key, unreachable) is
                       the useful one. After a sign-in it means no session cookie. */
                    if (apiKey && status && status.error) throw status.error;
                    throw new SeerrError(0, apiKey
                        ? 'Could not reach Seerr'
                        : 'Signed in, but Seerr did not keep the session');
                }
                return status;
            })
            .catch(function (err) {
                restore();
                if (err && err.status === 404) {
                    throw new SeerrError(404, missingMessage ||
                        'This Seerr has no Jellyfin sign-in. Use an API key instead.');
                }
                throw err;
            });
    }

    /* --------------------------------------------------------------- API */

    var Seerr = {
        Error: SeerrError,
        image: image,
        titleOf: titleOf,
        yearOf: yearOf,
        mediaTypeOf: mediaTypeOf,
        statusOf: statusOf,
        region: region,
        providersOf: providersOf,
        results: results,

        normalizeUrl: normalizeUrl,
        url: seerrUrl,
        configured: isConfigured,

        /* Change the address. A different address drops the old connection. */
        setUrl: function (url) {
            var next = normalizeUrl(url);
            if (next === seerrUrl()) return;
            Store.setPref('seerrUrl', next);
            Store.setPref('seerrKey', '');
            Store.setPref('seerrMode', '');
            statusCache = null;
            statusInflight = null;
        },

        /* Use an API key, but only keep it if Seerr accepts it: a typo must
           not replace a connection that works. */
        useKey: function (url, key) {
            return openSession(url, function () {}, '', String(key || '').replace(/\s+/g, ''));
        },

        /* Save an address and API key. Empty values turn Seerr off. */
        configure: function (url, key) {
            Store.setPref('seerrUrl', normalizeUrl(url));
            Store.setPref('seerrKey', String(key || '').replace(/\s+/g, ''));
            Store.setPref('seerrMode', '');
            statusCache = null;
            statusInflight = null;
        },

        /* Sign in with the Jellyfin account. Seerr answers with a session
           cookie; nothing secret is stored here, only that the cookie is used. */
        login: function (url, username, password) {
            if (!username || !password) {
                return Promise.reject(new SeerrError(0, 'Enter the Jellyfin password'));
            }
            return openSession(url, function () {
                return call('POST', '/auth/jellyfin', { username: username, password: password });
            });
        },

        /* Quick Connect: Seerr hands out a code, this TV approves it with its
           own Jellyfin login, then Seerr opens a session for that user. If the
           TV cannot approve it (older Jellyfin, a different server) the code is
           reported through onCode so the viewer can enter it in Jellyfin's
           Quick Connect screen on another device. Cancel with isCancelled(). */
        quickConnect: function (url, handlers) {
            var hooks = handlers || {};
            var secret = '';
            var deadline = Date.now() + QUICK_CONNECT_WAIT_MS;

            function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

            function untilApproved() {
                if (hooks.isCancelled && hooks.isCancelled()) {
                    throw new SeerrError(0, 'Cancelled');
                }
                if (Date.now() > deadline) {
                    throw new SeerrError(0, 'The code was not approved in time');
                }
                return call('GET', '/auth/jellyfin/quickconnect/check', null, { secret: secret })
                    .then(function (state) {
                        if (state && state.authenticated) return true;
                        return wait(2000).then(untilApproved);
                    });
            }

            return openSession(url, function () {
                return call('POST', '/auth/jellyfin/quickconnect/initiate').then(function (started) {
                    if (!started || !started.code || !started.secret) {
                        throw new SeerrError(0, 'Seerr did not return a Quick Connect code');
                    }
                    secret = started.secret;
                    return global.Api.quickConnectAuthorize(started.code).then(function () {
                        return true;
                    }, function () {
                        return false;
                    }).then(function (approved) {
                        if (!approved && hooks.onCode) hooks.onCode(started.code);
                    });
                }).then(untilApproved).then(function () {
                    return call('POST', '/auth/jellyfin/quickconnect/authenticate', { secret: secret });
                });
            }, 'This Seerr has no Quick Connect (it needs Seerr 3.4 or newer on Jellyfin). ' +
                'Use the Jellyfin password or an API key instead.');
        },

        /* Forget the Seerr connection on this TV. */
        disconnect: function () {
            var wasSession = sessionMode() && isConfigured();
            var done = wasSession ? call('POST', '/auth/logout').catch(function () {}) : Promise.resolve();
            return done.then(function () {
                /* The address stays, so connecting again is one step. */
                Store.setPref('seerrKey', '');
                Store.setPref('seerrMode', '');
                statusCache = null;
                statusInflight = null;
            });
        },

        mode: function () { return sessionMode() ? 'session' : (seerrKey() ? 'key' : ''); },

        /* Probe once per session. `force` re-checks after the viewer changes
           the address or key. /auth/me needs a valid key, unlike /status. */
        status: function (force) {
            if (!isConfigured()) return Promise.resolve({ configured: false, available: false });
            if (!force && statusCache) return Promise.resolve(statusCache);
            if (statusInflight) return statusInflight;

            statusInflight = call('GET', '/auth/me').then(function (payload) {
                var value = { configured: true, available: true, user: payload || null };
                statusCache = value;
                statusInflight = null;
                return value;
            }).catch(function (err) {
                statusInflight = null;
                /* Not cached: the next screen may have a working connection. */
                return { configured: true, available: false, error: err };
            });

            return statusInflight;
        },

        reset: function () { statusCache = null; statusInflight = null; },

        trending: function () {
            return call('GET', '/discover/trending').then(results);
        },

        movies: function (params) {
            return call('GET', '/discover/movies', null, params || {}).then(results);
        },

        tv: function (params) {
            return call('GET', '/discover/tv', null, params || {}).then(results);
        },

        upcomingMovies: function () {
            return call('GET', '/discover/movies/upcoming').then(results);
        },

        upcomingTv: function () {
            return call('GET', '/discover/tv/upcoming').then(results);
        },

        search: function (query) {
            return call('GET', '/search', null, { query: query, page: 1 }).then(results);
        },

        detail: function (mediaType, tmdbId) {
            var path = (mediaType === 'tv' ? '/tv/' : '/movie/') + tmdbId;
            return call('GET', path);
        },

        similar: function (mediaType, tmdbId) {
            var path = (mediaType === 'tv' ? '/tv/' : '/movie/') + tmdbId + '/similar';
            return call('GET', path, null, { page: 1 }).then(results);
        },

        requests: function () {
            return call('GET', '/request', null, { take: 100, filter: 'all' }).then(results);
        },

        request: function (options) {
            var body = {
                mediaType: options.mediaType === 'tv' ? 'tv' : 'movie',
                mediaId: options.mediaId,
                is4k: false
            };
            if (body.mediaType === 'tv') {
                body.seasons = (options.seasons || []).filter(function (n) {
                    return Number(n) > 0 || Number(n) === 0;
                });
            }
            return call('POST', '/request', body);
        },

        cancelRequest: function (requestId) {
            return call('DELETE', '/request/' + requestId);
        },

        watchlist: function () {
            return call('GET', '/discover/watchlist').then(results);
        },

        addToWatchlist: function (mediaType, mediaId) {
            return call('POST', '/watchlist', { tmdbId: mediaId, mediaType: mediaType });
        },

        removeFromWatchlist: function (mediaType, mediaId) {
            return call('DELETE', '/watchlist/' + mediaId);
        },

        /* Watchlist payloads across Seerr versions use both `results` and a
           bare array; the detail flag is the reliable one, so only optimistic
           local state is read from these lists. */
        normalizeWatchlist: function (payload) {
            return payload || [];
        }
    };

    global.Seerr = Seerr;
})(window);

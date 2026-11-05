/* Seerr (Jellyseerr / Overseerr) discovery through the Litefin Jellyfin plugin.
   Every call goes to /Litefin/Seerr/* with the signed-in Jellyfin token, so the
   TV never stores a Seerr URL or API key. */
(function (global) {
    'use strict';

    var ROOT = '/Litefin/Seerr';
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

    function target(path, params) {
        var qs = params ? queryString(params) : '';
        return Api.base + ROOT + path + (qs ? '?' + qs : '');
    }

    function call(method, path, body, params) {
        var url = target(path, params);
        var payload = (body === undefined || body === null) ? null : JSON.stringify(body);
        var headers = Api.headers(payload !== null);
        headers['Accept'] = 'application/json';

        function fail(status, text) {
            var message = 'HTTP ' + status;
            try {
                var parsed = JSON.parse(text);
                message = parsed.message || parsed.Message || message;
            } catch (e) { /* not JSON */ }
            if (status === 401 && Api.notifyUnauthorized) Api.notifyUnauthorized();
            return new SeerrError(status, message);
        }

        if (!global.fetch) {
            return new Promise(function (resolve, reject) {
                var xhr = new XMLHttpRequest();
                xhr.open(method, url, true);
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
       The plugin returns every region, so this is a local filter. */
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

        /* Probe once per session. `force` re-checks after the viewer fixes the
           plugin configuration. */
        status: function (force) {
            if (!force && statusCache) return Promise.resolve(statusCache);
            if (statusInflight) return statusInflight;

            statusInflight = call('GET', '/Status').then(function (payload) {
                var value = {
                    configured: !!(payload && payload.configured),
                    available: !!(payload && payload.available)
                };
                statusCache = value;
                statusInflight = null;
                return value;
            }).catch(function (err) {
                statusInflight = null;
                /* A network failure is not cached: the next screen may have a
                   working connection. */
                return { configured: false, available: false, error: err };
            });

            return statusInflight;
        },

        reset: function () { statusCache = null; statusInflight = null; },

        trending: function () {
            return call('GET', '/Discover/Trending').then(results);
        },

        movies: function (params) {
            return call('GET', '/Discover/Movies', null, params || {}).then(results);
        },

        tv: function (params) {
            return call('GET', '/Discover/Tv', null, params || {}).then(results);
        },

        upcomingMovies: function () {
            return call('GET', '/Discover/Movies/Upcoming').then(results);
        },

        upcomingTv: function () {
            return call('GET', '/Discover/Tv/Upcoming').then(results);
        },

        search: function (query) {
            return call('GET', '/Search', null, { query: query, page: 1 }).then(results);
        },

        detail: function (mediaType, tmdbId) {
            var path = (mediaType === 'tv' ? '/Tv/' : '/Movie/') + tmdbId;
            return call('GET', path);
        },

        similar: function (mediaType, tmdbId) {
            var path = (mediaType === 'tv' ? '/Tv/' : '/Movie/') + tmdbId + '/Similar';
            return call('GET', path, null, { page: 1 }).then(results);
        },

        requests: function () {
            return call('GET', '/Requests').then(results);
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
            return call('POST', '/Requests', body);
        },

        cancelRequest: function (requestId) {
            return call('DELETE', '/Requests/' + requestId);
        },

        watchlist: function () {
            return call('GET', '/Watchlist').then(results);
        },

        addToWatchlist: function (mediaType, mediaId) {
            return call('POST', '/Watchlist', { mediaType: mediaType, mediaId: mediaId });
        },

        removeFromWatchlist: function (mediaType, mediaId) {
            return call('DELETE', '/Watchlist/' + mediaType + '/' + mediaId);
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

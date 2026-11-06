/* Persisted configuration + credentials.
   One localStorage record; the access token is scoped to this TV only. */
(function (global) {
    'use strict';

    /* The key predates the rename; keeping it means an installed TV stays
       signed in instead of landing on the setup screen. */
    var KEY = 'jellyfinLean.config.v1';
    var data = load();

    function load() {
        try {
            var raw = localStorage.getItem(KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }

    function save() {
        try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {
            console.error('Unable to persist config', e);
        }
    }

    function randomHex(length) {
        var out = '';
        var c = global.crypto || global.msCrypto;
        if (c && c.getRandomValues && global.Uint8Array) {
            var bytes = new Uint8Array(Math.ceil(length / 2));
            c.getRandomValues(bytes);
            for (var b = 0; b < bytes.length; b++) {
                out += (bytes[b] < 16 ? '0' : '') + bytes[b].toString(16);
            }
            return out.slice(0, length);
        }
        var alphabet = '0123456789abcdef';
        for (var i = 0; i < length; i++) {
            out += alphabet.charAt(Math.floor(Math.random() * 16));
        }
        return out;
    }

    var Store = {
        get: function (key, fallback) {
            return data[key] === undefined ? fallback : data[key];
        },

        set: function (key, value) {
            data[key] = value;
            save();
        },

        remove: function (key) {
            delete data[key];
            save();
        },

        /* Stable per-install identifier: Jellyfin uses it to keep sessions and
           SyncPlay participants distinguishable. */
        deviceId: function () {
            if (!data.deviceId) {
                data.deviceId = randomHex(32);
                save();
            }
            return data.deviceId;
        },

        deviceName: function () {
            return data.deviceName || 'Samsung TV';
        },

        auth: function () {
            return {
                serverUrl: data.serverUrl || '',
                token: data.token || '',
                userId: data.userId || '',
                userName: data.userName || '',
                serverId: data.serverId || ''
            };
        },

        isLoggedIn: function () {
            return !!(data.serverUrl && data.token && data.userId);
        },

        saveAuth: function (result) {
            data.serverUrl = result.serverUrl;
            data.token = result.token;
            data.userId = result.userId;
            data.userName = result.userName || '';
            data.serverId = result.serverId || '';
            save();
        },

        clearAuth: function () {
            delete data.token;
            delete data.userId;
            delete data.userName;
            delete data.serverId;
            save();
        },

        prefs: function () {
            return data.prefs || {};
        },

        pref: function (key, fallback) {
            var prefs = data.prefs || {};
            return prefs[key] === undefined ? fallback : prefs[key];
        },

        setPref: function (key, value) {
            data.prefs = data.prefs || {};
            data.prefs[key] = value;
            save();
        }
    };

    global.Store = Store;
})(window);

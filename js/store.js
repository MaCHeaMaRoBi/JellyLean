/* Persisted configuration + credentials.
   One localStorage record. Each account keeps its own token and its own
   preferences, so two people sharing the TV cannot see each other's choices. */
(function (global) {
    'use strict';

    /* The key predates the rename; keeping it means an installed TV stays
       signed in instead of landing on the setup screen. */
    var KEY = 'jellyfinLean.config.v1';

    /* These describe the TV, not the viewer: the bitrate it can decode, the
       speakers it has, the codecs it claims. Switching user must not change
       what the device tells the server, so they stay device-wide. */
    var DEVICE_PREFS = { maxBitrate: 1, audioOutput: 1, allowHevc: 1 };

    var data = load();
    migrate();

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

    function findAccount(list, id) {
        for (var i = 0; list && i < list.length; i++) {
            if (list[i].id === id) return list[i];
        }
        return null;
    }

    function newAccountId() {
        var id;
        do { id = 'acct-' + randomHex(10); } while (findAccount(data.accounts, id));
        return id;
    }

    function accountCopy(account) {
        if (!account) return null;
        return {
            id: account.id,
            serverUrl: account.serverUrl || '',
            serverId: account.serverId || '',
            serverName: account.serverName || '',
            userId: account.userId || '',
            userName: account.userName || '',
            token: account.token || ''
        };
    }

    /* A config written before accounts existed holds one login at the top
       level. Wrap it, and move that viewer's prefs into their own bag, so an
       installed TV stays signed in. */
    function migrate() {
        data.accounts = data.accounts || [];

        if (data.serverUrl && data.token && data.userId) {
            var id = newAccountId();
            data.accounts.push({
                id: id,
                serverUrl: data.serverUrl,
                serverId: data.serverId || '',
                serverName: data.serverName || '',
                userId: data.userId,
                userName: data.userName || '',
                token: data.token
            });
            data.activeAccountId = id;

            if (data.prefs) {
                var bag = accountPrefs(id, true);
                for (var key in data.prefs) {
                    if (!data.prefs.hasOwnProperty(key) || DEVICE_PREFS[key]) continue;
                    bag[key] = data.prefs[key];
                    delete data.prefs[key];
                }
            }

            delete data.serverUrl;
            delete data.serverId;
            delete data.serverName;
            delete data.userId;
            delete data.userName;
            delete data.token;
            save();
        } else if (data.accounts.length && !findAccount(data.accounts, data.activeAccountId)) {
            data.activeAccountId = data.accounts[0].id;
            save();
        }
    }

    /* The active account's preference bag. Before anyone signs in the old
       global bag is still used, so the setup screen can persist its own bits. */
    function accountPrefs(id, create) {
        if (!id) {
            if (create) data.prefs = data.prefs || {};
            return data.prefs || {};
        }
        data.accountPrefs = data.accountPrefs || {};
        if (!data.accountPrefs[id] && create) data.accountPrefs[id] = {};
        return data.accountPrefs[id] || {};
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
           SyncPlay participants distinguishable. It is not per account. */
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

        accounts: function () {
            var out = [];
            for (var i = 0; i < data.accounts.length; i++) {
                out.push(accountCopy(data.accounts[i]));
            }
            return out;
        },

        activeAccount: function () {
            return accountCopy(findAccount(data.accounts, data.activeAccountId));
        },

        auth: function () {
            return accountCopy(findAccount(data.accounts, data.activeAccountId)) ||
                { serverUrl: '', token: '', userId: '', userName: '', serverId: '' };
        },

        isLoggedIn: function () {
            var account = findAccount(data.accounts, data.activeAccountId);
            return !!(account && account.serverUrl && account.token && account.userId);
        },

        /* Signing in again for the same server + user refreshes that account
           instead of adding a duplicate card. */
        saveAuth: function (result) {
            var account = null;
            for (var i = 0; i < data.accounts.length; i++) {
                if (data.accounts[i].serverUrl === result.serverUrl &&
                        data.accounts[i].userId === result.userId) {
                    account = data.accounts[i];
                    break;
                }
            }

            if (!account) {
                account = {
                    id: newAccountId(),
                    serverUrl: result.serverUrl,
                    serverId: result.serverId || '',
                    serverName: result.serverName || '',
                    userId: result.userId,
                    userName: result.userName || '',
                    token: result.token
                };
                data.accounts.push(account);
                /* Anything configured before the first sign-in (the setup
                   screen has no prefs, but a debug console or a future screen
                   might) belongs to the account that just signed in. */
                var bag = accountPrefs(account.id, true);
                var globals = data.prefs || {};
                for (var key in globals) {
                    if (!globals.hasOwnProperty(key) || DEVICE_PREFS[key]) continue;
                    bag[key] = globals[key];
                    delete globals[key];
                }
            } else {
                account.token = result.token;
                account.userName = result.userName || account.userName || '';
                account.serverId = result.serverId || account.serverId || '';
                account.serverName = result.serverName || account.serverName || '';
            }

            data.activeAccountId = account.id;
            save();
            return accountCopy(account);
        },

        switchAccount: function (id) {
            var account = findAccount(data.accounts, id);
            if (!account) return null;
            data.activeAccountId = id;
            save();
            return accountCopy(account);
        },

        removeAccount: function (id) {
            var found = false;
            for (var i = data.accounts.length - 1; i >= 0; i--) {
                if (data.accounts[i].id !== id) continue;
                data.accounts.splice(i, 1);
                found = true;
            }
            if (!found) return false;

            if (data.accountPrefs) delete data.accountPrefs[id];
            /* Nothing is implicitly active after a sign out: the picker asks. */
            if (data.activeAccountId === id) data.activeAccountId = '';
            save();
            return true;
        },

        /* Sign out removes the active account (and only that one): its token,
           its prefs and its Seerr connection. Other accounts stay usable. */
        clearAuth: function () {
            if (!data.activeAccountId) return;
            Store.removeAccount(data.activeAccountId);
        },

        prefs: function () {
            return accountPrefs(data.activeAccountId, false);
        },

        pref: function (key, fallback) {
            var bag = DEVICE_PREFS[key] ? (data.prefs || {}) : accountPrefs(data.activeAccountId, false);
            return bag[key] === undefined ? fallback : bag[key];
        },

        setPref: function (key, value) {
            var bag = DEVICE_PREFS[key] ? (data.prefs = data.prefs || {}) : accountPrefs(data.activeAccountId, true);
            bag[key] = value;
            save();
        }
    };

    global.Store = Store;
})(window);

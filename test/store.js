#!/usr/bin/env node
/* Account storage: migration, add/switch/remove, per-account prefs.
   No server, browser or dependencies:
     node test/store.js */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..');
var KEY = 'jellyfinLean.config.v1';
var passed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  ok   ' + name);
    } catch (e) {
        console.error('  FAIL ' + name + '\n       ' + (e && e.message));
        process.exitCode = 1;
    }
}

/* A fresh Store over a fake localStorage. `seed` is the parsed config. */
function boot(seed) {
    var raw = seed ? JSON.stringify(seed) : null;
    var storage = raw === null ? {} : { 'jellyfinLean.config.v1': raw };
    var window = {
        localStorage: {
            getItem: function (key) { return storage[key] === undefined ? null : storage[key]; },
            setItem: function (key, value) { storage[key] = String(value); },
            removeItem: function (key) { delete storage[key]; }
        },
        crypto: {
            getRandomValues: function (bytes) {
                for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
                return bytes;
            }
        },
        Uint8Array: Uint8Array,
        console: console
    };
    window.window = window;
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/store.js'), 'utf8'), window,
        { filename: 'js/store.js' });
    return {
        Store: window.Store,
        raw: function () { return JSON.parse(storage['jellyfinLean.config.v1'] || '{}'); }
    };
}

function legacyConfig() {
    return {
        deviceId: 'device-1',
        lastServer: 'http://tv.local:8096',
        serverUrl: 'http://tv.local:8096',
        serverId: 'srv-1',
        userId: 'u1',
        userName: 'Ana',
        token: 'token-ana',
        prefs: {
            subtitleChoices: { movie1: 3 },
            audioChoices: { movie1: 2 },
            seerrUrl: 'http://seerr.local:5055',
            seerrKey: 'key-ana',
            seerrMode: 'key',
            maxBitrate: 12,
            audioOutput: 'stereo'
        }
    };
}

test('a legacy single-account config migrates in place', function () {
    var app = boot(legacyConfig());
    var Store = app.Store;

    assert.strictEqual(Store.isLoggedIn(), true, 'still signed in after the upgrade');
    assert.strictEqual(Store.accounts().length, 1);
    assert.strictEqual(Store.auth().userName, 'Ana');
    assert.strictEqual(Store.auth().token, 'token-ana');
    assert.strictEqual(Store.auth().serverUrl, 'http://tv.local:8096');
    assert.strictEqual(Store.deviceId(), 'device-1', 'device id survives the migration');
    assert.strictEqual(Store.accounts()[0].id, Store.activeAccount().id);

    var raw = app.raw();
    assert.strictEqual(raw.serverUrl, undefined, 'the old top-level login is gone');
    assert.strictEqual(raw.accounts.length, 1);
});

test('the migrated viewer keeps their prefs, and Seerr follows the account', function () {
    var app = boot(legacyConfig());
    var Store = app.Store;

    assert.deepEqual(Store.pref('subtitleChoices'), { movie1: 3 });
    assert.deepEqual(Store.pref('audioChoices'), { movie1: 2 });
    assert.strictEqual(Store.pref('seerrKey'), 'key-ana');
    assert.strictEqual(Store.pref('seerrMode'), 'key');
    assert.strictEqual(Store.pref('seerrUrl'), 'http://seerr.local:5055');
    /* Device capabilities stay where they were: the TV did not change. */
    assert.strictEqual(Store.pref('maxBitrate'), 12);
    assert.strictEqual(Store.pref('audioOutput'), 'stereo');
});

test('a second account is added and switching swaps the session', function () {
    var app = boot(legacyConfig());
    var Store = app.Store;

    Store.saveAuth({
        serverUrl: 'http://tv.local:8096', serverId: 'srv-1', serverName: 'Living room',
        userId: 'u2', userName: 'Ben', token: 'token-ben'
    });

    assert.strictEqual(Store.accounts().length, 2, 'no duplicate server entry');
    assert.strictEqual(Store.auth().userName, 'Ben', 'the new login is active');
    assert.strictEqual(Store.accounts()[1].serverName, 'Living room');

    var ana = Store.accounts()[0];
    Store.switchAccount(ana.id);
    assert.strictEqual(Store.auth().userName, 'Ana');
    assert.strictEqual(Store.auth().token, 'token-ana');

    Store.switchAccount('missing');
    assert.strictEqual(Store.auth().userName, 'Ana', 'an unknown id changes nothing');
});

test('signing in again updates the entry instead of duplicating it', function () {
    var app = boot(legacyConfig());
    var Store = app.Store;

    Store.saveAuth({
        serverUrl: 'http://tv.local:8096', serverId: 'srv-1', serverName: 'Living room',
        userId: 'u1', userName: 'Ana', token: 'token-ana-2'
    });

    assert.strictEqual(Store.accounts().length, 1);
    assert.strictEqual(Store.auth().token, 'token-ana-2');
    assert.strictEqual(Store.accounts()[0].id, app.raw().accounts[0].id, 'the id is stable');
});

test('per-title and Seerr prefs do not leak between accounts', function () {
    var app = boot(legacyConfig());
    var Store = app.Store;
    var ana = Store.auth();

    Store.saveAuth({
        serverUrl: 'http://tv.local:8096', serverId: 'srv-1',
        userId: 'u2', userName: 'Ben', token: 'token-ben'
    });
    var ben = Store.accounts()[1];

    assert.strictEqual(Store.pref('seerrKey', ''), '', 'Ben did not inherit Ana’s key');
    assert.deepEqual(Store.pref('subtitleChoices', {}), {}, 'nor her subtitle pick');
    assert.strictEqual(Store.pref('maxBitrate'), 12, 'the TV cap is shared');

    Store.setPref('subtitleChoices', { show2: 4 });
    Store.setPref('seerrKey', 'key-ben');

    Store.switchAccount(ana.id);
    assert.deepEqual(Store.pref('subtitleChoices'), { movie1: 3 });
    assert.strictEqual(Store.pref('seerrKey'), 'key-ana');

    Store.switchAccount(ben.id);
    assert.deepEqual(Store.pref('subtitleChoices'), { show2: 4 });
    assert.strictEqual(Store.pref('seerrKey'), 'key-ben');
});

test('clearAuth drops only the active account and its prefs', function () {
    var app = boot(legacyConfig());
    var Store = app.Store;

    Store.saveAuth({
        serverUrl: 'http://tv.local:8096', serverId: 'srv-1',
        userId: 'u2', userName: 'Ben', token: 'token-ben'
    });
    var ben = Store.auth();

    Store.switchAccount(Store.accounts()[0].id);   /* Ana */
    Store.clearAuth();

    assert.strictEqual(Store.isLoggedIn(), false, 'nothing is active after a sign out');
    assert.strictEqual(Store.accounts().length, 1);
    assert.strictEqual(Store.accounts()[0].userName, 'Ben');
    assert.strictEqual(Store.accounts()[0].token, 'token-ben');

    Store.switchAccount(ben.id);
    assert.strictEqual(Store.pref('seerrKey', ''), '', 'Ben never had Ana’s key');
    assert.strictEqual(Store.pref('maxBitrate'), 12, 'device prefs outlive the account');

    Store.clearAuth();
    assert.strictEqual(Store.accounts().length, 0);
});

test('prefs configured before the first sign-in follow that account', function () {
    var app = boot(null);
    var Store = app.Store;

    Store.setPref('seerrKey', 'pre-login');
    Store.setPref('maxBitrate', 8);
    Store.saveAuth({
        serverUrl: 'http://tv.local:8096', serverId: 'srv-1',
        userId: 'u1', userName: 'Ana', token: 'token-ana'
    });

    assert.strictEqual(Store.pref('seerrKey'), 'pre-login');
    assert.strictEqual(Store.pref('maxBitrate'), 8, 'device prefs stay device-wide');
    assert.strictEqual(app.raw().prefs.seerrKey, undefined, 'the global copy is gone');
});

test('removing a non-active account leaves the session alone', function () {
    var app = boot(legacyConfig());
    var Store = app.Store;

    Store.saveAuth({
        serverUrl: 'http://tv.local:8096', serverId: 'srv-1',
        userId: 'u2', userName: 'Ben', token: 'token-ben'
    });
    var ana = Store.accounts()[0];
    var ben = Store.auth();

    assert.strictEqual(Store.removeAccount(ana.id), true);
    assert.strictEqual(Store.auth().userId, ben.userId, 'still Ben');
    assert.strictEqual(Store.accounts().length, 1);
    assert.strictEqual(Store.removeAccount(ana.id), false, 'removing it again is a no-op');
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));

#!/usr/bin/env node
/* Pins what the TV tells the server it can decode, and the audio-track logic
   that depends on it. No server, browser or dependencies:
     node test/profile.js
   A change to the device profile changes what the server sends to the TV, and
   a wrong one shows up as silence or a black picture, so every claim is
   asserted here on purpose. */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..');

function load(file, window) {
    var code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInNewContext(code, window, { filename: file });
}

/* The scripts only need `window`; Store is stubbed with a plain map. */
var prefs = {};
var window = {
    Store: {
        pref: function (key, fallback) { return prefs[key] === undefined ? fallback : prefs[key]; },
        setPref: function (key, value) { prefs[key] = value; }
    },
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    location: { protocol: 'http:', hostname: 'localhost' },
    navigator: { userAgent: 'node' }
};
window.window = window;
window.U = {};

load('js/api.js', window);
load('js/audio.js', window);
load('js/util.js', window);

var Api = window.Api;
var AudioPrefs = window.AudioPrefs;
var U = window.U;
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

function codecs(list) { return list.split(','); }
function direct(profile, container) {
    return profile.DirectPlayProfiles.filter(function (p) {
        return p.Type === 'Video' && codecs(p.Container).indexOf(container) !== -1;
    })[0];
}
function hls(profile) {
    return profile.TranscodingProfiles.filter(function (p) { return p.Protocol === 'hls'; })[0];
}
function stream(index, language, codec, channels, extra) {
    var s = { Type: 'Audio', Index: index, Language: language, Codec: codec, Channels: channels };
    for (var key in (extra || {})) s[key] = extra[key];
    return s;
}

console.log('device profile');

test('defaults to surround: AC3 first, six channels', function () {
    var t = hls(Api.deviceProfile(false, 0));
    assert.strictEqual(t.AudioCodec, 'ac3,eac3,aac');
    assert.strictEqual(t.MaxAudioChannels, '6');
});

test('stereo mode asks for AAC, two channels', function () {
    var t = hls(Api.deviceProfile(false, 0, { surround: false }));
    assert.strictEqual(t.AudioCodec, 'aac');
    assert.strictEqual(t.MaxAudioChannels, '2');
});

test('direct play audio is only what the TV decodes', function () {
    var p = Api.deviceProfile(false, 0);
    ['mp4', 'mkv', 'ts'].forEach(function (container) {
        var audio = codecs(direct(p, container).AudioCodec).sort();
        assert.deepStrictEqual(audio, ['aac', 'ac3', 'eac3', 'mp3']);
    });
    ['dts', 'truehd', 'dtshd', 'opus', 'vorbis', 'flac'].forEach(function (bad) {
        assert.strictEqual(direct(p, 'mkv').AudioCodec.indexOf(bad), -1, bad + ' must not be claimed');
    });
});

test('surround caps direct-play audio at 6 channels, stereo does not', function () {
    function cap(profile) {
        return profile.CodecProfiles.filter(function (c) { return c.Type === 'VideoAudio'; })[0];
    }
    var on = cap(Api.deviceProfile(false, 0));
    assert.ok(on, 'surround mode needs a VideoAudio rule');
    assert.strictEqual(on.Conditions[0].Property, 'AudioChannels');
    assert.strictEqual(on.Conditions[0].Value, '6');
    assert.strictEqual(on.Conditions[0].IsRequired, true);
    assert.strictEqual(cap(Api.deviceProfile(false, 0, { surround: false })), undefined);
});

test('HEVC is not claimed unless asked for', function () {
    var off = Api.deviceProfile(false, 0);
    ['mp4', 'mkv', 'ts'].forEach(function (c) {
        assert.strictEqual(/hevc|h265/.test(direct(off, c).VideoCodec), false);
    });
    assert.strictEqual(off.CodecProfiles.some(function (c) { return /hevc/.test(c.Codec); }), false);
});

test('allowing HEVC adds it to direct play, still capped to 1080p', function () {
    var on = Api.deviceProfile(false, 0, { hevc: true });
    ['mp4', 'mkv', 'ts'].forEach(function (c) {
        assert.ok(/hevc/.test(direct(on, c).VideoCodec), c + ' should list hevc');
    });
    var rule = on.CodecProfiles.filter(function (c) { return /hevc/.test(c.Codec); })[0];
    assert.ok(rule, 'HEVC needs a codec rule');
    var props = {};
    rule.Conditions.forEach(function (c) { props[c.Property] = c; });
    assert.strictEqual(props.Width.Value, '1920');
    assert.strictEqual(props.Width.IsRequired, true);
    assert.strictEqual(props.Height.Value, '1080');
    assert.strictEqual(props.Height.IsRequired, true);
});

test('transcoding output stays H.264 whatever direct play allows', function () {
    assert.strictEqual(hls(Api.deviceProfile(false, 0, { hevc: true })).VideoCodec, 'h264');
});

test('H.264 is held to 1920x1080, 8 bit, level 4.1', function () {
    var rule = Api.deviceProfile(false, 0).CodecProfiles.filter(function (c) { return c.Codec === 'h264'; })[0];
    var props = {};
    rule.Conditions.forEach(function (c) { props[c.Property] = c.Value; });
    assert.strictEqual(props.Width, '1920');
    assert.strictEqual(props.Height, '1080');
    assert.strictEqual(props.VideoBitDepth, '8');
    assert.strictEqual(props.VideoLevel, '41');
});

test('forcing a transcode removes every direct-play profile', function () {
    assert.strictEqual(Api.deviceProfile(true, 0).DirectPlayProfiles.length, 0);
});

test('the bitrate cap is applied, and absent means uncapped', function () {
    assert.strictEqual(Api.deviceProfile(false, 8).MaxStreamingBitrate, 8000000);
    assert.ok(Api.deviceProfile(false, 0).MaxStreamingBitrate >= 1000000000);
});

test('image subtitles are burned in, text ones stay external', function () {
    var methods = {};
    Api.deviceProfile(false, 0).SubtitleProfiles.forEach(function (s) { methods[s.Format] = s.Method; });
    assert.strictEqual(methods.srt, 'External');
    assert.strictEqual(methods.pgssub, 'Encode');
});

console.log('transcode info');

test('reads codec, channels and reasons from a transcoding URL', function () {
    var info = Api.transcodeInfo('/videos/1/master.m3u8?AudioCodec=ac3&TranscodingMaxAudioChannels=6' +
        '&TranscodeReasons=VideoCodecNotSupported%2CAudioCodecNotSupported');
    assert.strictEqual(info.audioCodec, 'ac3');
    assert.strictEqual(info.audioChannels, 6);
    /* Arrays from the vm sandbox have another prototype; compare as JSON. */
    assert.strictEqual(JSON.stringify(info.reasons),
        JSON.stringify(['VideoCodecNotSupported', 'AudioCodecNotSupported']));
});

test('takes the first codec of a list and tolerates a bare path', function () {
    assert.strictEqual(Api.transcodeInfo('/x?AudioCodec=ac3,aac').audioCodec, 'ac3');
    assert.strictEqual(Api.transcodeInfo('/x'), null);
    assert.strictEqual(Api.transcodeInfo(''), null);
});

console.log('audio tracks');

test('language codes compare across 2- and 3-letter and B/T forms', function () {
    assert.strictEqual(AudioPrefs.canon('fre'), 'fra');
    assert.strictEqual(AudioPrefs.canon('FR'), 'fra');
    assert.strictEqual(AudioPrefs.canon('ger'), 'deu');
    assert.strictEqual(AudioPrefs.canon('en'), 'eng');
    assert.strictEqual(AudioPrefs.canon('und'), '');
    assert.strictEqual(AudioPrefs.canon(null), '');
});

test('the default track is the flagged one, else the first', function () {
    var a = stream(1, 'eng', 'ac3', 6);
    var b = stream(2, 'jpn', 'aac', 2, { IsDefault: true });
    assert.strictEqual(AudioPrefs.pick({ MediaStreams: [a, b] }).Index, 2);
    assert.strictEqual(AudioPrefs.pick({ MediaStreams: [a, b] }, 1).Index, 1);
    assert.strictEqual(AudioPrefs.pick({ MediaStreams: [a] }).Index, 1);
    assert.strictEqual(AudioPrefs.pick({ MediaStreams: [] }), null);
});

test('only codecs the TV decodes can be switched to in place', function () {
    assert.strictEqual(AudioPrefs.directPlayable(stream(1, 'eng', 'ac3', 6), true), true);
    assert.strictEqual(AudioPrefs.directPlayable(stream(1, 'eng', 'truehd', 8), true), false);
    assert.strictEqual(AudioPrefs.directPlayable(stream(1, 'eng', 'dts', 6), true), false);
    assert.strictEqual(AudioPrefs.directPlayable(stream(1, 'eng', 'eac3', 8), true), false);
    assert.strictEqual(AudioPrefs.directPlayable(stream(1, 'eng', 'eac3', 8), false), true);
    assert.strictEqual(AudioPrefs.directPlayable(null, true), false);
});

test('picks the right track in a language: no commentary, default first, most channels', function () {
    var src = { MediaStreams: [
        stream(1, 'eng', 'ac3', 2, { Title: 'Director commentary' }),
        stream(2, 'jpn', 'aac', 2),
        stream(3, 'eng', 'ac3', 2),
        stream(4, 'eng', 'eac3', 6)
    ] };
    assert.strictEqual(AudioPrefs.bestInLanguage(src, 'eng').Index, 4);
    assert.strictEqual(AudioPrefs.bestInLanguage(src, 'en').Index, 4);
    assert.strictEqual(AudioPrefs.bestInLanguage(src, 'jpn').Index, 2);
    assert.strictEqual(AudioPrefs.bestInLanguage(src, 'deu'), null);
    assert.strictEqual(AudioPrefs.bestInLanguage(src, ''), null);

    src.MediaStreams[2].IsDefault = true;
    assert.strictEqual(AudioPrefs.bestInLanguage(src, 'eng').Index, 3, 'a default flag beats channel count');
});

test('a commentary is chosen only when it is all there is', function () {
    var src = { MediaStreams: [stream(1, 'eng', 'ac3', 2, { Title: 'Commentary' })] };
    assert.strictEqual(AudioPrefs.bestInLanguage(src, 'eng').Index, 1);
});

test('a remembered language beats the Settings one, and Settings applies otherwise', function () {
    var item = { Id: 'm1', Type: 'Movie' };
    var src = { MediaStreams: [stream(1, 'eng', 'ac3', 6), stream(2, 'jpn', 'aac', 2)] };

    assert.strictEqual(AudioPrefs.preferredStream(item, src), null, 'no preference leaves it to the server');

    prefs.audioLanguage = 'eng';
    assert.strictEqual(AudioPrefs.preferredStream(item, src).Index, 1);

    AudioPrefs.saveChoice(item, src.MediaStreams[1]);
    assert.strictEqual(AudioPrefs.preferredStream(item, src).Index, 2);

    assert.strictEqual(AudioPrefs.preferredStream({ Id: 'm2', Type: 'Movie' }, src).Index, 1,
        'another movie keeps the Settings language');
    prefs = {};
});

test('an episode choice covers the whole series', function () {
    var ep1 = { Id: 'e1', Type: 'Episode', SeriesId: 's1' };
    var ep2 = { Id: 'e2', Type: 'Episode', SeriesId: 's1' };
    var src = { MediaStreams: [stream(1, 'eng', 'ac3', 6), stream(5, 'jpn', 'aac', 2)] };

    AudioPrefs.saveChoice(ep1, src.MediaStreams[1]);
    assert.strictEqual(AudioPrefs.preferredStream(ep2, src).Index, 5);
    prefs = {};
});

test('an untagged track clears the remembered language instead of pinning it', function () {
    var item = { Id: 'm1', Type: 'Movie' };
    var src = { MediaStreams: [stream(1, 'eng', 'ac3', 6), stream(2, '', 'aac', 2)] };

    AudioPrefs.saveChoice(item, src.MediaStreams[0]);
    AudioPrefs.saveChoice(item, src.MediaStreams[1]);
    assert.strictEqual(AudioPrefs.preferredStream(item, src), null);
    prefs = {};
});

test('AVPlay track numbers map by position when the lists line up', function () {
    var src = { MediaStreams: [
        { Type: 'Video', Index: 0 },
        stream(1, 'eng', 'ac3', 6),
        stream(2, 'jpn', 'aac', 2)
    ] };
    var tracks = [{ index: 1, language: 'eng' }, { index: 2, language: 'jpn' }];
    assert.strictEqual(AudioPrefs.avplayIndex(src, src.MediaStreams[2], tracks), 2);
    assert.strictEqual(AudioPrefs.avplayIndex(src, src.MediaStreams[1], tracks), 1);
});

test('the mapping is refused when it cannot be trusted', function () {
    var src = { MediaStreams: [stream(1, 'eng', 'ac3', 6), stream(2, 'jpn', 'aac', 2)] };

    assert.strictEqual(AudioPrefs.avplayIndex(src, src.MediaStreams[1],
        [{ index: 1, language: 'eng' }]), -1, 'different track counts');
    assert.strictEqual(AudioPrefs.avplayIndex(src, src.MediaStreams[1],
        [{ index: 1, language: 'jpn' }, { index: 2, language: 'eng' }]), -1, 'language disagrees');
    assert.strictEqual(AudioPrefs.avplayIndex(src, src.MediaStreams[1], null), -1);
    assert.strictEqual(AudioPrefs.avplayIndex(src, null, []), -1);
});

test('a missing language on either side does not block the mapping', function () {
    var src = { MediaStreams: [stream(1, 'eng', 'ac3', 6), stream(2, '', 'aac', 2)] };
    var tracks = [{ index: 4, language: '' }, { index: 5, language: 'jpn' }];
    assert.strictEqual(AudioPrefs.avplayIndex(src, src.MediaStreams[1], tracks), 5);
});

/* The stall watchdog: a slow NAS start must not be called a dead stream, and
   a dead low-bitrate stream must not hold the viewer for 12 s. */
test('the stall limit scales with the bitrate', function () {
    assert.strictEqual(U.stallLimitMs(0), 12000, 'no bitrate: the minimum');
    assert.strictEqual(U.stallLimitMs(2000000), 12000, 'a small episode waits for a slow disk');
    assert.strictEqual(U.stallLimitMs(10000000), 15000);
    assert.strictEqual(U.stallLimitMs(20000000), 25000);
    assert.strictEqual(U.stallLimitMs(40000000), 45000, 'a big remux gets patience');
    assert.strictEqual(U.stallLimitMs(200000000), 45000, 'but never more than 45 s');
});

test('a caller floor can only raise the stall limit', function () {
    assert.strictEqual(U.stallLimitMs(2000000, 40000), 40000, 'transcode floor wins');
    assert.strictEqual(U.stallLimitMs(40000000, 40000), 45000, 'bitrate still wins above it');
    assert.strictEqual(U.stallLimitMs(40000000, 0), 45000);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));

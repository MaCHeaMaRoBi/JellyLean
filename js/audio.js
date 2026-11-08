/* Audio track helpers shared by the player, App and Settings.
   Pure functions plus the per-title language choice, so they can be tested in
   Node without a TV (test/profile.js). Named AudioPrefs because `Audio` is the
   browser's own constructor. */
(function (global) {
    'use strict';

    /* Codecs this TV can decode itself, i.e. what the device profile lists for
       direct play. Anything else needs the server to re-encode it. */
    var DIRECT_CODECS = { aac: true, mp3: true, ac3: true, eac3: true };
    var MAX_SURROUND_CHANNELS = 6;

    /* Jellyfin sends ISO 639-2 codes, sometimes the bibliographic form (fre)
       and sometimes the terminological one (fra); AVPlay and Settings may use
       two letters. Everything is folded to one three-letter form to compare. */
    var CANON = {
        fre: 'fra', ger: 'deu', dut: 'nld', chi: 'zho', cze: 'ces', gre: 'ell',
        rum: 'ron', slo: 'slk', per: 'fas', ice: 'isl', mac: 'mkd', may: 'msa',
        wel: 'cym', arm: 'hye', baq: 'eus', geo: 'kat', bur: 'mya', tib: 'bod',
        alb: 'sqi',
        ar: 'ara', cs: 'ces', da: 'dan', de: 'deu', el: 'ell', en: 'eng',
        es: 'spa', fi: 'fin', fr: 'fra', hi: 'hin', hr: 'hrv', hu: 'hun',
        it: 'ita', ja: 'jpn', ko: 'kor', nl: 'nld', no: 'nor', pl: 'pol',
        pt: 'por', ro: 'ron', ru: 'rus', sv: 'swe', tr: 'tur', uk: 'ukr',
        zh: 'zho'
    };

    /* The languages offered in Settings. The value is the canonical code. */
    var LANGUAGES = [
        { value: '', label: 'Auto (server default)' },
        { value: 'eng', label: 'English' },
        { value: 'ron', label: 'Romanian' },
        { value: 'deu', label: 'German' },
        { value: 'fra', label: 'French' },
        { value: 'spa', label: 'Spanish' },
        { value: 'ita', label: 'Italian' },
        { value: 'nld', label: 'Dutch' },
        { value: 'pol', label: 'Polish' },
        { value: 'por', label: 'Portuguese' },
        { value: 'rus', label: 'Russian' },
        { value: 'hun', label: 'Hungarian' },
        { value: 'jpn', label: 'Japanese' },
        { value: 'kor', label: 'Korean' }
    ];

    function canon(code) {
        var value = String(code === undefined || code === null ? '' : code).toLowerCase();
        value = value.replace(/[^a-z]/g, '');
        if (!value || value === 'und' || value === 'unk' || value === 'zxx') return '';
        return CANON[value] || value;
    }

    function streams(source) {
        var all = (source && source.MediaStreams) || [];
        var list = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i].Type === 'Audio') list.push(all[i]);
        }
        return list;
    }

    function byIndex(list) {
        return list.slice().sort(function (a, b) { return Number(a.Index) - Number(b.Index); });
    }

    /* The stream the viewer sees as "current" when nothing was chosen: the one
       flagged default, else the first. Same rule the player always used. */
    function pick(source, index) {
        var list = streams(source);
        var chosen = null;
        var first = null;
        var flagged = null;

        for (var i = 0; i < list.length; i++) {
            if (index !== undefined && index !== null && index >= 0 &&
                    Number(list[i].Index) === Number(index)) {
                chosen = list[i];
            }
            if (!first) first = list[i];
            if (list[i].IsDefault && !flagged) flagged = list[i];
        }
        return chosen || flagged || first || null;
    }

    /* True when this TV can decode the track itself, so switching to it needs
       no server round trip. `surround` is the Settings choice: a stereo-only
       setup still decodes 5.1 itself, the cap only guards the 7.1 case. */
    function directPlayable(stream, surround) {
        if (!stream) return false;
        if (!DIRECT_CODECS[String(stream.Codec || '').toLowerCase()]) return false;
        if (surround !== false && stream.Channels && Number(stream.Channels) > MAX_SURROUND_CHANNELS) {
            return false;
        }
        return true;
    }

    function isCommentary(stream) {
        return /commentary|description|descriptive/i.test(
            String(stream.Title || '') + ' ' + String(stream.DisplayTitle || ''));
    }

    /* The best track in `code`'s language: not a commentary, flagged default
       first, then the most channels. null when the file has none in it. */
    function bestInLanguage(source, code) {
        var want = canon(code);
        if (!want) return null;

        var best = null;
        var list = streams(source);
        for (var i = 0; i < list.length; i++) {
            if (canon(list[i].Language) !== want) continue;
            if (!best) { best = list[i]; continue; }

            var a = best;
            var b = list[i];
            if (isCommentary(a) !== isCommentary(b)) {
                if (isCommentary(a)) best = b;
                continue;
            }
            if (!!a.IsDefault !== !!b.IsDefault) {
                if (b.IsDefault) best = b;
                continue;
            }
            if ((Number(b.Channels) || 0) > (Number(a.Channels) || 0)) best = b;
        }
        return best;
    }

    /* ----------------------------------------------------- remembered choices */

    /* One entry per movie and per series, like the subtitle picker, so picking
       Japanese for one episode sticks for the rest of the show. */
    function choiceKey(item) {
        if (!item) return '';
        if (item.Type === 'Episode' && item.SeriesId) return 'series:' + item.SeriesId;
        return item.Id ? 'item:' + item.Id : '';
    }

    function savedLanguage(item) {
        var key = choiceKey(item);
        if (!key || !global.Store) return '';
        var choices = global.Store.pref('audioChoices', {});
        return choices && choices[key] ? canon(choices[key].language) : '';
    }

    function saveChoice(item, stream) {
        var key = choiceKey(item);
        if (!key || !global.Store || !stream) return;

        var language = canon(stream.Language);
        var choices = global.Store.pref('audioChoices', {});
        if (!choices || typeof choices !== 'object') choices = {};

        /* A track with no language tag cannot be matched on the next episode,
           so it clears the memory instead of pinning a stale language. */
        if (language) choices[key] = { language: language };
        else delete choices[key];
        global.Store.setPref('audioChoices', choices);
    }

    function globalLanguage() {
        return global.Store ? canon(global.Store.pref('audioLanguage', '')) : '';
    }

    /* The track to start with: this title's remembered language, else the
       Settings language. null leaves the choice to the server and container. */
    function preferredStream(item, source) {
        var language = savedLanguage(item) || globalLanguage();
        return language ? bestInLanguage(source, language) : null;
    }

    /* --------------------------------------------------------------- AVPlay */

    /* AVPlay numbers its audio tracks by its own index, in container order, and
       knows nothing about Jellyfin's stream index. When both sides list the
       same number of audio tracks the k-th one is the same track; a language
       mismatch at that position means the order is not what we assumed, and
       the caller falls back to restarting the stream. Returns the AVPlay track
       index, or -1 when the mapping cannot be trusted. */
    function avplayIndex(source, stream, tracks) {
        if (!stream || !tracks) return -1;
        var list = byIndex(streams(source));
        if (!list.length || list.length !== tracks.length) return -1;

        for (var i = 0; i < list.length; i++) {
            if (Number(list[i].Index) !== Number(stream.Index)) continue;

            var theirs = canon(tracks[i].language);
            var ours = canon(list[i].Language);
            if (theirs && ours && theirs !== ours) return -1;
            return tracks[i].index;
        }
        return -1;
    }

    global.AudioPrefs = {
        LANGUAGES: LANGUAGES,
        canon: canon,
        streams: streams,
        pick: pick,
        directPlayable: directPlayable,
        bestInLanguage: bestInLanguage,
        preferredStream: preferredStream,
        saveChoice: saveChoice,
        avplayIndex: avplayIndex
    };
})(typeof window !== 'undefined' ? window : this);

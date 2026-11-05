/* Subtitle tracks.
   Text subtitles are fetched as WebVTT and drawn over the video by this module:
   AVPlay ignores HTML <track>, and burning a text track costs a full transcoder
   session. Image tracks (PGS/DVD) cannot be drawn here, so the player asks the
   server to burn those into a transcode instead. This module also owns the
   per-movie / per-series choice that survives a restart. */
(function (global) {
    'use strict';

    var TEXT_CODECS = {
        srt: true, subrip: true, vtt: true, webvtt: true,
        ass: true, ssa: true, ttml: true, mov_text: true, text: true
    };

    var IMAGE_CODECS = {
        pgssub: true, pgs: true, 'hdmv-pgs-subtitle': true,
        dvdsub: true, 'dvd-subtitle': true, dvbsub: true, vobsub: true
    };

    /* Samsung's engine has no Intl.DisplayNames, and the server sends ISO
       639-2 codes. A small table covers the languages this library actually
       carries and reads better than "RON" at ten feet. */
    var LANGUAGE_NAMES = {
        ara: 'Arabic', ces: 'Czech', chi: 'Chinese', zho: 'Chinese',
        cze: 'Czech', dan: 'Danish', deu: 'German', dut: 'Dutch',
        ell: 'Greek', eng: 'English', est: 'Estonian', fin: 'Finnish',
        fra: 'French', fre: 'French', ger: 'German', gre: 'Greek',
        hrv: 'Croatian', hun: 'Hungarian', ita: 'Italian', jpn: 'Japanese',
        kor: 'Korean', lav: 'Latvian', lit: 'Lithuanian', nld: 'Dutch',
        nor: 'Norwegian', pol: 'Polish', por: 'Portuguese', ron: 'Romanian',
        rum: 'Romanian', rus: 'Russian', slk: 'Slovak', slo: 'Slovak',
        spa: 'Spanish', srp: 'Serbian', swe: 'Swedish', tha: 'Thai',
        tur: 'Turkish', ukr: 'Ukrainian', vie: 'Vietnamese',
        en: 'English', ro: 'Romanian', ja: 'Japanese', de: 'German',
        fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
        nl: 'Dutch', pl: 'Polish', ru: 'Russian', sv: 'Swedish',
        da: 'Danish', fi: 'Finnish', no: 'Norwegian', el: 'Greek',
        cs: 'Czech', hu: 'Hungarian', ko: 'Korean', zh: 'Chinese',
        ar: 'Arabic', tr: 'Turkish', th: 'Thai', hr: 'Croatian'
    };

    function code(value) {
        return String(value || '').toLowerCase().replace(/_/g, '-');
    }

    function languageName(value) {
        if (!value) return 'Unknown';
        return LANGUAGE_NAMES[code(value)] || String(value).toUpperCase();
    }

    function pickDefault(source) {
        if (!source || !source.MediaStreams) return null;

        var streams = source.MediaStreams;
        var wanted = [
            function (s) { return s.IsForced && s.IsDefault; },
            function (s) { return s.IsForced; },
            function (s) { return s.IsDefault; }
        ];

        for (var w = 0; w < wanted.length; w++) {
            for (var i = 0; i < streams.length; i++) {
                var stream = streams[i];
                if (stream.Type === 'Subtitle' && wanted[w](stream) &&
                    TEXT_CODECS[code(stream.Codec)]) {
                    return stream;
                }
            }
        }
        return null;
    }

    function choiceKey(item) {
        if (!item || !item.Id) return '';
        /* Episodes of one show share a preference; a movie is its own scope. */
        if (item.Type === 'Episode' && item.SeriesId) return 'series:' + item.SeriesId;
        return 'item:' + item.Id;
    }

    function loadChoice(item) {
        var key = choiceKey(item);
        if (!key || !global.Store) return null;
        var choices = global.Store.pref('subtitleChoices', {});
        return choices && choices[key] ? choices[key] : null;
    }

    function saveChoice(item, stream) {
        var key = choiceKey(item);
        if (!key || !global.Store) return;

        var choices = global.Store.pref('subtitleChoices', {});
        if (!choices || typeof choices !== 'object') choices = {};

        if (!stream) {
            choices[key] = { off: true };
        } else {
            choices[key] = {
                index: stream.Index,
                codec: stream.Codec || '',
                language: stream.Language || '',
                title: stream.Title || ''
            };
        }
        global.Store.setPref('subtitleChoices', choices);
    }

    /* Identity beats index: the next episode of a series may number its tracks
       differently, but the language/codec/title still describes the same one. */
    function matchStream(source, choice) {
        if (!source || !choice) return null;

        var streams = source.MediaStreams || [];
        var best = null;
        var bestScore = 0;

        for (var i = 0; i < streams.length; i++) {
            var stream = streams[i];
            if (stream.Type !== 'Subtitle') continue;

            var score = 0;
            if (choice.index !== undefined && choice.index === stream.Index) score += 1;
            if (choice.codec && code(choice.codec) === code(stream.Codec)) score += 4;
            if (choice.language && code(choice.language) === code(stream.Language)) score += 6;
            if (choice.title && String(choice.title) === String(stream.Title || '')) score += 3;

            if (score > bestScore) {
                best = stream;
                bestScore = score;
            }
        }

        /* Language alone (6) or codec alone (4) is a real match; an index on
           its own is only meaningful inside the same file and is not enough. */
        return bestScore >= 4 ? best : null;
    }

    function preferred(item, source) {
        var choice = loadChoice(item);

        if (choice) {
            if (choice.off) return { stream: null, off: true, saved: true };
            var saved = matchStream(source, choice);
            if (saved) return { stream: saved, off: false, saved: true };
            /* A series can gain or lose a track between episodes. Fall back to
               the default rather than silently leaving the viewer with none. */
        }

        var fallback = pickDefault(source);
        return { stream: fallback, off: !fallback, saved: !!choice };
    }

    /* "01:14.100", "00:01:14.100", "00:01:14,100" */
    function milliseconds(value) {
        var m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(String(value || '').trim());
        if (!m) return NaN;
        var hours = m[1] ? parseInt(m[1], 10) : 0;
        var minutes = parseInt(m[2], 10);
        var seconds = parseInt(m[3], 10);
        var fraction = m[4] ? parseInt((m[4] + '000').slice(0, 3), 10) : 0;
        return hours * 3600000 + minutes * 60000 + seconds * 1000 + fraction;
    }

    function plainText(value) {
        return String(value)
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]*>/g, '')
            .replace(/\{\\[^}]*\}/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#(\d+);/g, function (all, code) { return String.fromCharCode(parseInt(code, 10)); })
            .trim();
    }

    function parse(vtt) {
        var cues = [];
        var blocks = String(vtt || '').replace(/^\uFEFF/, '').split(/\r?\n\r?\n/);

        for (var i = 0; i < blocks.length; i++) {
            var lines = blocks[i].split(/\r?\n/);
            var timing = -1;

            for (var j = 0; j < lines.length; j++) {
                if (lines[j].indexOf('-->') >= 0) { timing = j; break; }
            }
            /* Blocks without timing are WEBVTT, NOTE, STYLE or REGION headers. */
            if (timing < 0) continue;

            var bounds = lines[timing].split('-->');
            var start = milliseconds(bounds[0]);
            /* Cue settings may follow the end time. */
            var end = milliseconds(String(bounds[1] || '').trim().split(/\s+/)[0]);
            if (isNaN(start) || isNaN(end) || end <= start) continue;

            var text = plainText(lines.slice(timing + 1).join('\n'));
            if (!text) continue;

            cues.push({ start: start, end: end, text: text });
        }

        cues.sort(function (a, b) { return a.start - b.start; });
        return cues;
    }

    function Tracker(cues) {
        this.cues = cues || [];
        this.cursor = 0;
        this.lastMs = 0;
    }

    Tracker.prototype.textAt = function (positionMs) {
        var ms = Math.max(0, positionMs || 0);

        /* Seeking backwards invalidates the cursor. */
        if (ms < this.lastMs - 1000) this.cursor = 0;
        this.lastMs = ms;

        while (this.cursor < this.cues.length && this.cues[this.cursor].end <= ms) this.cursor++;

        var out = [];
        for (var i = this.cursor; i < this.cues.length && this.cues[i].start <= ms; i++) {
            if (ms < this.cues[i].end) out.push(this.cues[i].text);
        }
        return out.join('\n');
    };

    /* XHR rather than fetch: the 2017 TV web engine is older than the rest of
       the app's Chrome assumptions, and Api already talks to the server this
       way. The first request for an embedded track makes the server extract it,
       which can take a while, hence the generous timeout. */
    function load(url) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.timeout = 45000;
            xhr.onload = function () {
                if (xhr.status < 200 || xhr.status >= 300) {
                    reject(new Error('subtitle HTTP ' + xhr.status));
                    return;
                }
                resolve(new Tracker(parse(xhr.responseText)));
            };
            xhr.onerror = function () { reject(new Error('subtitle network error')); };
            xhr.ontimeout = function () { reject(new Error('subtitle timed out')); };
            xhr.send();
        });
    }

    global.Subtitles = {
        load: load,
        parse: parse,
        Tracker: Tracker,

        isTextCodec: function (value) {
            return !!TEXT_CODECS[code(value)];
        },
        isImageCodec: function (value) {
            return !!IMAGE_CODECS[code(value)];
        },

        languageName: languageName,
        pickDefault: pickDefault,
        choiceKey: choiceKey,
        loadChoice: loadChoice,
        saveChoice: saveChoice,
        matchStream: matchStream,
        preferred: preferred,

        imagePreference: function (item, source) {
            var pref = preferred(item, source);
            return pref.stream && IMAGE_CODECS[code(pref.stream.Codec)] ? pref.stream : null;
        }
    };
})(window);
